import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError, serializeError } from "../core/errors.js";
import type { ErrorCode } from "../core/errors.js";
import type { Id } from "../core/ids.js";
import { VERSION } from "../version.js";
import { resolveCommand } from "../executors/command-resolution.js";
import type { ProcessStarter } from "../executors/codex-executor.js";
import {
  DEFAULT_EXECUTOR_TIMING,
  signalExecution,
  type ExecutorEvidence,
  type ExecutorResult,
  type ExecutorTiming
} from "../executors/executor.js";
import type { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";

const ENVIRONMENT_ALLOWLIST = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"] as const;
const CODEX_NODE_TARGET = ["@openai", "codex", "bin", "codex.js"] as const;
const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 20;
const MAX_CURSOR_LENGTH = 4_096;
const DEFAULT_MAX_TURNS = 5;
const MAX_TURNS = 10;
const MAX_TURN_TEXT_BYTES = 4_096;
const MAX_HISTORY_BYTES = 16_384;
const MAX_OUTPUT_BYTES = 16_384;
const MAX_EVIDENCE = 50;
const MAX_EVIDENCE_BYTES = 65_536;
const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2_048;
const TRUNCATION_MARKER = "[truncated]";
const THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
] as const;
const THREAD_STATUS_KINDS = new Set(["notLoaded", "idle", "systemError", "active"]);

export type CodexSourceKind = (typeof THREAD_SOURCE_KINDS)[number];

export interface CodexThreadListRequest {
  readonly workspace_id: string;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly source_kinds?: readonly CodexSourceKind[] | undefined;
}

export interface CodexThreadSummary {
  readonly thread_id: string;
  readonly name?: string | undefined;
  readonly preview?: string | undefined;
  readonly created_at?: number | undefined;
  readonly updated_at?: number | undefined;
  readonly source_kind?: CodexSourceKind | undefined;
  readonly status: string;
  readonly ephemeral: boolean;
}

export interface CodexThreadListResult {
  readonly threads: readonly CodexThreadSummary[];
  readonly next_cursor?: string | undefined;
}

export interface CodexThreadTurn {
  readonly turn_id: string;
  readonly status: string;
  readonly user_text?: string | undefined;
  readonly assistant_text?: string | undefined;
}

export interface CodexThreadReadResult {
  readonly thread_id: string;
  readonly name?: string | undefined;
  readonly source_kind?: CodexSourceKind | undefined;
  readonly status: string;
  readonly ephemeral: boolean;
  readonly turns: readonly CodexThreadTurn[];
  readonly truncated: boolean;
  readonly truncation?: string | undefined;
}

export interface CodexThreadReadRequest {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly max_turns?: number | undefined;
}

export interface CodexThreadTaskRequest {
  readonly workspace_id: string;
  readonly source_thread_id: string;
  readonly instruction: string;
  readonly model?: string | undefined;
  readonly reasoning_effort?: string | undefined;
}

export interface CodexThreadWorkerSession {
  readonly sourceThreadId: string;
  readonly workerThreadId: string;
  run(
    taskId: Id,
    instruction: string,
    onEvidence?: (evidence: readonly ExecutorEvidence[]) => void
  ): Promise<ExecutorResult>;
  steer(instruction: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export type CodexThreadWorkerFactory = (
  request: CodexThreadTaskRequest
) => Promise<CodexThreadWorkerSession>;

export interface CodexThreadServiceTiming extends ExecutorTiming {
  readonly rpcCallTimeoutMs?: number;
}

type JsonObject = Record<string, unknown>;
type NotificationHandler = (method: string, params: JsonObject) => void;
type ClosedHandler = (error: CoreError) => void;

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: CoreError) => void;
  readonly timer: NodeJS.Timeout;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function environment(host: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_ALLOWLIST) {
    const value = host[key];
    if (value) result[key] = value;
  }
  return result;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  if (maxBytes <= markerBytes) return TRUNCATION_MARKER.slice(0, maxBytes);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") + markerBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low) + TRUNCATION_MARKER;
}

function bounded(value: unknown, maxBytes: number): string {
  return typeof value === "string" ? truncateUtf8(value, maxBytes) : "";
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new CoreError("CODEX_PROTOCOL_ERROR");
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function threadStatus(value: unknown): string {
  if (!isObject(value) || typeof value.type !== "string" || !THREAD_STATUS_KINDS.has(value.type)) {
    throw new CoreError("CODEX_PROTOCOL_ERROR");
  }
  return value.type;
}

function turnStatus(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return bounded(value, 64);
  if (isObject(value) && typeof value.type === "string" && value.type.length > 0) {
    return bounded(value.type, 64);
  }
  throw new CoreError("CODEX_PROTOCOL_ERROR");
}

function sourceKind(thread: JsonObject): CodexSourceKind | undefined {
  const value = thread.sourceKind ?? thread.source;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !THREAD_SOURCE_KINDS.includes(value as CodexSourceKind)) {
    throw new CoreError("CODEX_PROTOCOL_ERROR");
  }
  return value as CodexSourceKind;
}

function outputWithThread(
  result: ExecutorResult,
  threadId: string,
  diagnostics: { executor_started_at: string; executor_ended_at: string }
): ExecutorResult {
  return {
    ...result,
    ...(result.threadId === undefined ? { threadId } : {}),
    diagnostics
  };
}

class CodexAppServerConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingCall>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly closedHandlers = new Set<ClosedHandler>();
  private readonly processExitHandler = (): void => this.terminateChild();

  constructor(
    private readonly workspaceRoot: string,
    private readonly startProcess: ProcessStarter,
    private readonly hostEnvironment: Readonly<NodeJS.ProcessEnv>,
    private readonly platform: NodeJS.Platform,
    private readonly timing: CodexThreadServiceTiming
  ) {
    process.once("exit", this.processExitHandler);
  }

  async open(): Promise<void> {
    const options: SpawnOptionsWithoutStdio = {
      cwd: this.workspaceRoot,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.platform !== "win32",
      env: environment(this.hostEnvironment)
    };
    try {
      const resolved = resolveCommand(this.hostEnvironment, "codex", {
        nodeTarget: CODEX_NODE_TARGET,
        platform: this.platform
      });
      const child = resolved.kind === "direct"
        ? this.startProcess(resolved.executable, ["app-server", "--stdio"], options)
        : resolved.kind === "node-launcher"
          ? this.startProcess(process.execPath, [resolved.scriptPath, "app-server", "--stdio"], options)
          : this.startProcess("codex", ["app-server", "--stdio"], options);
      this.child = child;
      this.attach(child);
    } catch {
      throw new CoreError("CODEX_UNAVAILABLE");
    }

    try {
      await this.call("initialize", { clientInfo: { name: "engineering-bridge", version: VERSION } });
      this.notify("initialized", {});
    } catch (error) {
      await this.close();
      throw error instanceof CoreError ? error : new CoreError("CODEX_PROTOCOL_ERROR");
    }
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onClosed(handler: ClosedHandler): () => void {
    this.closedHandlers.add(handler);
    return () => this.closedHandlers.delete(handler);
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (this.closed || this.child === undefined || this.child.stdin.destroyed) {
      return Promise.reject(new CoreError("CODEX_UNAVAILABLE"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.pending.get(id);
        if (waiter === undefined) return;
        this.pending.delete(id);
        waiter.reject(new CoreError("CODEX_PROTOCOL_ERROR"));
      }, this.timing.rpcCallTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child?.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      } catch {
        const waiter = this.pending.get(id);
        if (waiter === undefined) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.reject(new CoreError("CODEX_UNAVAILABLE"));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed || this.child === undefined || this.child.stdin.destroyed) {
      throw new CoreError("CODEX_UNAVAILABLE");
    }
    try {
      this.child.stdin.write(JSON.stringify({ method, params }) + "\n");
    } catch {
      throw new CoreError("CODEX_UNAVAILABLE");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    process.off("exit", this.processExitHandler);
    this.rejectPending(new CoreError("CODEX_UNAVAILABLE"));
    this.terminateChild();
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    child.stdin.on("error", () => this.fail(new CoreError("CODEX_PROTOCOL_ERROR")));
    child.stdout.on("error", () => this.fail(new CoreError("CODEX_PROTOCOL_ERROR")));
    child.stderr.on("error", () => this.fail(new CoreError("CODEX_PROTOCOL_ERROR")));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => this.receive(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    child.on("error", () => this.fail(new CoreError("CODEX_PROTOCOL_ERROR")));
    child.on("exit", () => this.fail(new CoreError("CODEX_PROTOCOL_ERROR")));
    child.on("close", () => this.fail(new CoreError("CODEX_PROTOCOL_ERROR")));
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const rawLine = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(rawLine, "utf8") > MAX_JSONL_LINE_BYTES) {
        this.fail(new CoreError("CODEX_PROTOCOL_ERROR"));
        return;
      }
      const line = rawLine.trim();
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new CoreError("CODEX_PROTOCOL_ERROR"));
        return;
      }
      if (!isObject(message)) {
        this.fail(new CoreError("CODEX_PROTOCOL_ERROR"));
        return;
      }
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (waiter === undefined || (!("result" in message) && !("error" in message))) {
          this.fail(new CoreError("CODEX_PROTOCOL_ERROR"));
          return;
        }
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if ("error" in message) waiter.reject(new CoreError("CODEX_PROTOCOL_ERROR"));
        else waiter.resolve(message.result);
        continue;
      }
      if (typeof message.method !== "string" || !isObject(message.params)) {
        this.fail(new CoreError("CODEX_PROTOCOL_ERROR"));
        return;
      }
      for (const handler of this.notificationHandlers) handler(message.method, message.params);
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_JSONL_LINE_BYTES) {
      this.fail(new CoreError("CODEX_PROTOCOL_ERROR"));
    }
  }

  private fail(error: CoreError): void {
    if (this.closed) return;
    this.closed = true;
    process.off("exit", this.processExitHandler);
    this.rejectPending(error);
    this.terminateChild();
    for (const handler of this.closedHandlers) handler(error);
  }

  private terminateChild(): void {
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    signalExecution(child, this.platform, "SIGTERM");
    signalExecution(child, this.platform, "SIGKILL");
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }

  private rejectPending(error: CoreError): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

export class CodexThreadService {
  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly startProcess: ProcessStarter = spawn,
    private readonly hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly timing: CodexThreadServiceTiming = {
      ...DEFAULT_EXECUTOR_TIMING,
      rpcCallTimeoutMs: 30_000
    }
  ) {}

  async listThreads(request: CodexThreadListRequest): Promise<CodexThreadListResult> {
    const root = this.registry.resolveCanonicalRoot(request.workspace_id);
    const limit = this.listLimit(request.limit);
    const cursor = this.cursor(request.cursor);
    this.validateSourceKinds(request.source_kinds);
    const connection = this.connection(root);
    await connection.open();
    try {
      const result = await connection.call("thread/list", {
        cwd: root,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(request.source_kinds === undefined ? {} : { sourceKinds: request.source_kinds })
      });
      if (!isObject(result) || !Array.isArray(result.data)) throw new CoreError("CODEX_PROTOCOL_ERROR");
      const nextCursor = result.nextCursor;
      if (nextCursor !== null && typeof nextCursor !== "string") throw new CoreError("CODEX_PROTOCOL_ERROR");
      const threads: CodexThreadSummary[] = [];
      for (const value of result.data.slice(0, MAX_LIST_LIMIT)) {
        try {
          threads.push(this.projectSummary(value, root));
        } catch (error) {
          if (error instanceof CoreError && error.code === "WORKSPACE_BOUNDARY_VIOLATION") continue;
          throw error;
        }
      }
      if (nextCursor === null) return { threads };
      this.cursor(nextCursor);
      return { threads, next_cursor: nextCursor };
    } finally {
      await connection.close();
    }
  }

  async readThread(request: CodexThreadReadRequest): Promise<CodexThreadReadResult> {
    const root = this.registry.resolveCanonicalRoot(request.workspace_id);
    const maxTurns = this.maxTurns(request.max_turns);
    const connection = this.connection(root);
    await connection.open();
    try {
      const thread = await this.readSource(connection, root, request.thread_id, false);
      return this.projectRead(thread, maxTurns);
    } finally {
      await connection.close();
    }
  }

  async startWorker(request: CodexThreadTaskRequest): Promise<CodexThreadWorkerSession> {
    const root = this.registry.resolveCanonicalRoot(request.workspace_id);
    const connection = this.connection(root);
    try {
      await connection.open();
      await this.readSource(connection, root, request.source_thread_id, true);
      await this.validateModel(connection, request.model, request.reasoning_effort);
      const result = await connection.call("thread/fork", {
        threadId: request.source_thread_id,
        ephemeral: true
      });
      const workerThreadId = this.verifyFork(result, root, request.source_thread_id);
      return new EphemeralCodexThreadWorkerSession(
        connection,
        root,
        request.source_thread_id,
        workerThreadId,
        request.model,
        request.reasoning_effort,
        this.timing
      );
    } catch (error) {
      await connection.close();
      throw error instanceof CoreError ? error : new CoreError("CODEX_PROTOCOL_ERROR");
    }
  }

  private connection(root: string): CodexAppServerConnection {
    return new CodexAppServerConnection(
      root,
      this.startProcess,
      this.hostEnvironment,
      this.platform,
      this.timing
    );
  }

  private async readSource(
    connection: CodexAppServerConnection,
    root: string,
    threadId: string,
    requireSafeStatus: boolean
  ): Promise<JsonObject> {
    const result = await connection.call("thread/read", { threadId, includeTurns: true });
    if (!isObject(result) || !isObject(result.thread)) throw new CoreError("CODEX_PROTOCOL_ERROR");
    const thread = result.thread;
    if (thread.id !== threadId) throw new CoreError("CODEX_PROTOCOL_ERROR");
    if (typeof thread.cwd !== "string" || this.registry.canonicalizeRoot(thread.cwd) !== root) {
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
    const status = threadStatus(thread.status);
    if (requireSafeStatus && status !== "notLoaded") {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    return thread;
  }

  private projectSummary(value: unknown, root: string): CodexThreadSummary {
    if (!isObject(value) || typeof value.id !== "string" || value.id.length === 0) {
      throw new CoreError("CODEX_PROTOCOL_ERROR");
    }
    if (typeof value.cwd !== "string" || this.registry.canonicalizeRoot(value.cwd) !== root) {
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
    if (typeof value.ephemeral !== "boolean") throw new CoreError("CODEX_PROTOCOL_ERROR");
    const status = threadStatus(value.status);
    const source = sourceKind(value);
    const createdAt = optionalNumber(value.createdAt);
    const updatedAt = optionalNumber(value.updatedAt);
    return {
      thread_id: value.id,
      ...(typeof value.name === "string" ? { name: bounded(value.name, MAX_PREVIEW_BYTES) } : {}),
      ...(typeof value.preview === "string" ? { preview: bounded(value.preview, MAX_PREVIEW_BYTES) } : {}),
      ...(createdAt === undefined ? {} : { created_at: createdAt }),
      ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
      ...(source === undefined ? {} : { source_kind: source }),
      status,
      ephemeral: value.ephemeral
    };
  }

  private projectRead(thread: JsonObject, maxTurns: number): CodexThreadReadResult {
    const status = threadStatus(thread.status);
    if (typeof thread.ephemeral !== "boolean") throw new CoreError("CODEX_PROTOCOL_ERROR");
    if (!Array.isArray(thread.turns)) throw new CoreError("CODEX_PROTOCOL_ERROR");
    const allTurns = thread.turns.map((value) => this.projectTurn(value));
    let turns = allTurns.slice(Math.max(0, allTurns.length - maxTurns));
    let truncated = allTurns.length > turns.length;
    const source = sourceKind(thread);
    let result: CodexThreadReadResult = {
      thread_id: requiredString(thread.id),
      ...(typeof thread.name === "string" ? { name: bounded(thread.name, MAX_PREVIEW_BYTES) } : {}),
      ...(source === undefined ? {} : { source_kind: source }),
      status,
      ephemeral: thread.ephemeral,
      turns,
      truncated,
      ...(truncated ? { truncation: TRUNCATION_MARKER } : {})
    };

    while (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_HISTORY_BYTES) {
      let longest: { index: number; field: "user_text" | "assistant_text"; value: string } | undefined;
      turns.forEach((turn, index) => {
        for (const field of ["user_text", "assistant_text"] as const) {
          const value = turn[field];
          if (value !== undefined && (longest === undefined || value.length > longest.value.length)) {
            longest = { index, field, value };
          }
        }
      });
      if (longest !== undefined && longest.value !== TRUNCATION_MARKER) {
        turns = turns.map((turn, index) => index === longest!.index
          ? { ...turn, [longest!.field]: truncateUtf8(longest!.value, Math.max(
            Buffer.byteLength(TRUNCATION_MARKER, "utf8"),
            Math.floor(Buffer.byteLength(longest!.value, "utf8") * 0.75)
          )) }
          : turn);
        truncated = true;
        result = { ...result, turns, truncated, truncation: TRUNCATION_MARKER };
        continue;
      }
      if (turns.length === 0) throw new CoreError("CODEX_PROTOCOL_ERROR");
      turns = turns.slice(1);
      truncated = true;
      result = { ...result, turns, truncated, truncation: TRUNCATION_MARKER };
    }
    return result;
  }

  private projectTurn(value: unknown): CodexThreadTurn {
    if (!isObject(value)) throw new CoreError("CODEX_PROTOCOL_ERROR");
    const result: { turn_id: string; status: string; user_text?: string; assistant_text?: string } = {
      turn_id: requiredString(value.id),
      status: turnStatus(value.status)
    };
    if (Array.isArray(value.items)) {
      const userTexts: string[] = [];
      let assistantText = "";
      for (const item of value.items) {
        if (!isObject(item) || typeof item.type !== "string") continue;
        if (item.type === "userMessage") {
          const content = Array.isArray(item.content)
            ? item.content.filter(isObject).filter((entry) => entry.type === "text" && typeof entry.text === "string")
            : [];
          userTexts.push(...content.map((entry) => entry.text as string));
        } else if (item.type === "agentMessage" && typeof item.text === "string") {
          assistantText = item.text;
        }
      }
      if (userTexts.length > 0) result.user_text = truncateUtf8(userTexts.join("\n"), MAX_TURN_TEXT_BYTES);
      if (assistantText !== "") result.assistant_text = truncateUtf8(assistantText, MAX_TURN_TEXT_BYTES);
    }
    return result;
  }

  private verifyFork(result: unknown, root: string, sourceThreadId: string): string {
    if (!isObject(result) || !isObject(result.thread)) throw new CoreError("CODEX_PROTOCOL_ERROR");
    const fork = result.thread;
    const workerThreadId = requiredString(fork.id);
    if (workerThreadId === sourceThreadId ||
      fork.forkedFromId !== sourceThreadId ||
      fork.ephemeral !== true) {
      throw new CoreError("CODEX_PROTOCOL_ERROR");
    }
    if (fork.cwd !== undefined &&
      (typeof fork.cwd !== "string" || this.registry.canonicalizeRoot(fork.cwd) !== root)) {
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
    return workerThreadId;
  }

  private async validateModel(
    connection: CodexAppServerConnection,
    model: string | undefined,
    reasoningEffort: string | undefined
  ): Promise<void> {
    if (model === undefined && reasoningEffort === undefined) return;
    const result = await connection.call("model/list", {});
    if (!isObject(result) || !Array.isArray(result.data)) throw new CoreError("CODEX_PROTOCOL_ERROR");
    const models = result.data.filter(isObject).filter((entry) => typeof entry.model === "string");
    const selected = model === undefined
      ? models.find((entry) => entry.isDefault === true)
      : models.find((entry) => entry.model === model);
    if (selected === undefined) throw new CoreError("UNSUPPORTED_ACTION");
    if (reasoningEffort !== undefined) {
      const efforts = Array.isArray(selected.supportedReasoningEfforts) ? selected.supportedReasoningEfforts : [];
      if (!efforts.some((effort) => isObject(effort) && effort.reasoningEffort === reasoningEffort)) {
        throw new CoreError("UNSUPPORTED_ACTION");
      }
    }
  }

  private listLimit(value: number | undefined): number {
    if (value === undefined) return DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    return value;
  }

  private maxTurns(value: number | undefined): number {
    if (value === undefined) return DEFAULT_MAX_TURNS;
    if (!Number.isInteger(value) || value < 1 || value > MAX_TURNS) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    return value;
  }

  private cursor(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_CURSOR_LENGTH) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    return value;
  }

  private validateSourceKinds(value: readonly CodexSourceKind[] | undefined): void {
    if (value === undefined || value.length <= 8) {
      if (value?.every((entry) => THREAD_SOURCE_KINDS.includes(entry)) ?? true) return;
    }
    throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }
}

class EphemeralCodexThreadWorkerSession implements CodexThreadWorkerSession {
  private closed = false;
  private activeTurnId: string | undefined;

  constructor(
    private readonly connection: CodexAppServerConnection,
    private readonly workspaceRoot: string,
    readonly sourceThreadId: string,
    readonly workerThreadId: string,
    private readonly model: string | undefined,
    private readonly reasoningEffort: string | undefined,
    private readonly timing: CodexThreadServiceTiming
  ) {}

  async run(
    taskId: Id,
    instruction: string,
    onEvidence?: (evidence: readonly ExecutorEvidence[]) => void
  ): Promise<ExecutorResult> {
    void taskId;
    const executorStartedAt = new Date().toISOString();
    let result: ExecutorResult;
    try {
      result = await this.runTurn(instruction, onEvidence);
    } catch (error) {
      result = this.failed(error instanceof CoreError ? error.code : "CODEX_PROTOCOL_ERROR");
    }
    return outputWithThread(result, this.workerThreadId, {
      executor_started_at: executorStartedAt,
      executor_ended_at: new Date().toISOString()
    });
  }

  async steer(instruction: string): Promise<void> {
    if (this.closed || this.activeTurnId === undefined || !instruction.trim()) {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }
    await this.connection.call("turn/steer", {
      threadId: this.workerThreadId,
      expectedTurnId: this.activeTurnId,
      input: [{ type: "text", text: instruction }]
    });
  }

  async interrupt(): Promise<void> {
    if (this.closed || this.activeTurnId === undefined) {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }
    void this.connection.call("turn/interrupt", {
      threadId: this.workerThreadId,
      turnId: this.activeTurnId
    }).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.activeTurnId = undefined;
    await this.connection.close();
  }

  private runTurn(
    instruction: string,
    onEvidence?: (evidence: readonly ExecutorEvidence[]) => void
  ): Promise<ExecutorResult> {
    if (this.closed || this.activeTurnId !== undefined) {
      return Promise.reject(new CoreError("INVALID_STATE_TRANSITION"));
    }
    const evidence = new Map<string, ExecutorEvidence>();
    let evidenceDropped = 0;
    let output = "";
    let expectedTurnId: string | undefined;
    let earlyNotifications: Array<{ method: string; params: JsonObject }> = [];
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let inactivityTimer: NodeJS.Timeout | undefined;
    let resolveTurn!: (result: ExecutorResult) => void;
    const turnPromise = new Promise<ExecutorResult>((resolve) => { resolveTurn = resolve; });
    const visibleEvidence = (): readonly ExecutorEvidence[] => {
      const items = [...evidence.values()];
      return evidenceDropped === 0
        ? items
        : [...items, {
          id: "evidence-drop",
          type: "commandExecution" as const,
          status: "completed",
          command: evidenceDropped + " evidence item(s) dropped: evidence limit exceeded"
        }];
    };
    const emitEvidence = (): void => onEvidence?.(visibleEvidence());
    const enforceEvidenceBudget = (): void => {
      while (evidence.size > 0 &&
        Buffer.byteLength(JSON.stringify(visibleEvidence()), "utf8") > MAX_EVIDENCE_BYTES) {
        evidence.delete(evidence.keys().next().value as string);
        evidenceDropped += 1;
      }
    };
    const settle = (result: ExecutorResult): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      resolveTurn(result);
    };
    const failed = (code: ErrorCode): void => settle(this.failed(code, visibleEvidence()));
    const resetInactivity = (): void => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => failed("EXECUTOR_STALLED"),
        this.timing.protocolInactivityTimeoutMs ?? DEFAULT_EXECUTOR_TIMING.protocolInactivityTimeoutMs ?? 120_000
      );
    };
    const handleItem = (params: JsonObject): void => {
      const item = isObject(params.item) ? params.item : undefined;
      if (item === undefined || typeof item.id !== "string") return;
      if (item.type === "agentMessage") {
        if (typeof item.text === "string") output = truncateUtf8(item.text, MAX_OUTPUT_BYTES);
        return;
      }
      if (item.type !== "commandExecution" && item.type !== "fileChange") return;
      const status = typeof item.status === "string" ? bounded(item.status, 64) : "completed";
      if (item.type === "commandExecution") {
        evidence.set(item.id, {
          id: item.id,
          type: "commandExecution",
          status,
          command: bounded(item.command, MAX_OUTPUT_BYTES)
        });
      } else {
        const rawChanges = Array.isArray(item.changes) ? item.changes : [];
        const changes = rawChanges.slice(0, 49).filter(isObject).map((change) => ({
          path: bounded(change.path, MAX_OUTPUT_BYTES),
          diff: bounded(change.diff, MAX_OUTPUT_BYTES)
        }));
        if (rawChanges.length > 49) {
          changes.push({
            path: TRUNCATION_MARKER + ": " + (rawChanges.length - 49) + " additional changes omitted",
            diff: ""
          });
        }
        evidence.set(item.id, { id: item.id, type: "fileChange", status, changes });
      }
      while (evidence.size + (evidenceDropped > 0 ? 1 : 0) > MAX_EVIDENCE) {
        evidence.delete(evidence.keys().next().value as string);
        evidenceDropped += 1;
      }
      enforceEvidenceBudget();
      emitEvidence();
    };
    const handleNotification = (method: string, params: JsonObject): void => {
      if (params.threadId !== this.workerThreadId) return;
      if (expectedTurnId === undefined) {
        if (earlyNotifications.length < 100) earlyNotifications.push({ method, params });
        return;
      }
      if (params.turnId !== undefined && params.turnId !== expectedTurnId) return;
      resetInactivity();
      if (method === "item/started" || method === "item/completed") handleItem(params);
      if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
        output = truncateUtf8(output + params.delta, MAX_OUTPUT_BYTES);
      }
      if (method !== "turn/completed") return;
      if (!isObject(params.turn) || params.turn.id !== expectedTurnId) return;
      const status = params.turn.status;
      if (status === "completed") settle({
        kind: "completed",
        output,
        threadId: this.workerThreadId,
        evidence: visibleEvidence()
      });
      else if (status === "interrupted") settle({
        kind: "interrupted",
        output,
        threadId: this.workerThreadId,
        evidence: visibleEvidence()
      });
      else if (status === "failed") failed("CODEX_EXECUTION_FAILED");
      else failed("CODEX_PROTOCOL_ERROR");
    };
    const offNotification = this.connection.onNotification(handleNotification);
    const offClosed = this.connection.onClosed((error) => failed(error.code));
    deadlineTimer = setTimeout(
      () => failed("CODEX_EXECUTION_FAILED"),
      this.timing.executionTimeoutMs
    );

    const start = async (): Promise<ExecutorResult> => {
      try {
        const params: JsonObject = {
          threadId: this.workerThreadId,
          input: [{ type: "text", text: instruction }],
          cwd: this.workspaceRoot,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          ...(this.model === undefined ? {} : { model: this.model }),
          ...(this.reasoningEffort === undefined ? {} : { effort: this.reasoningEffort })
        };
        const result = await this.connection.call("turn/start", params);
        if (!isObject(result) || !isObject(result.turn)) throw new CoreError("CODEX_PROTOCOL_ERROR");
        expectedTurnId = requiredString(result.turn.id);
        this.activeTurnId = expectedTurnId;
        const notifications = earlyNotifications;
        earlyNotifications = [];
        for (const notification of notifications) handleNotification(notification.method, notification.params);
        if (!settled) {
          const status = result.turn.status;
          if (status === "completed") settle({
            kind: "completed",
            output,
            threadId: this.workerThreadId,
            evidence: visibleEvidence()
          });
          else if (status === "interrupted") settle({
            kind: "interrupted",
            output,
            threadId: this.workerThreadId,
            evidence: visibleEvidence()
          });
          else if (status !== "inProgress" && status !== "queued") failed("CODEX_PROTOCOL_ERROR");
          else resetInactivity();
        }
        return await turnPromise;
      } catch (error) {
        if (!settled) {
          const code = error instanceof CoreError ? error.code : "CODEX_PROTOCOL_ERROR";
          failed(code);
        }
        return await turnPromise;
      } finally {
        offNotification();
        offClosed();
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        if (this.activeTurnId === expectedTurnId) this.activeTurnId = undefined;
      }
    };
    return start();
  }

  private failed(code: ErrorCode, evidence?: readonly ExecutorEvidence[]): ExecutorResult {
    return {
      kind: "failed",
      error: serializeError(new CoreError(code)),
      threadId: this.workerThreadId,
      ...(evidence === undefined ? {} : { evidence })
    };
  }
}
