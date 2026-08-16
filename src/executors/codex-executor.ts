import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { CoreError, serializeError } from "../core/errors.js";
import { VERSION } from "../version.js";
import { resolveCommand } from "./command-resolution.js";
import type { Executor, ExecutorEvidence, ExecutorRequest, ExecutorResult } from "./executor.js";

export type ProcessStarter = (executable: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
const ENVIRONMENT_ALLOWLIST = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"] as const;
const MAX_EVIDENCE = 50;
const MAX_TEXT = 16_384;
// Official npm target of the Codex CLI, derived from a codex.cmd shim's
// location so a Windows npm install can be launched through Node directly
// (never through a shell).
const CODEX_NODE_TARGET = ["@openai", "codex", "bin", "codex.js"] as const;
// Machine- and human-readable marker appended to any bounded evidence string
// that was cut by MAX_TEXT, and the basis of the synthetic change/evidence
// entries that make list and count truncation visible.
const TRUNCATION_MARKER = "[truncated]";

function failure(code: "CODEX_UNAVAILABLE" | "CODEX_PROTOCOL_ERROR" | "CODEX_EXECUTION_FAILED"): ExecutorResult {
  return { kind: "failed", error: serializeError(new CoreError(code)) };
}
function failedTurn(turn: Record<string, unknown>): ExecutorResult {
  const error = object(turn.error) ? turn.error : undefined;
  if (error?.codexErrorInfo === "serverOverloaded") {
    return {
      kind: "failed",
      error: {
        code: "CODEX_EXECUTION_FAILED",
        message: "Codex execution failed: the selected model is at capacity."
      }
    };
  }
  return failure("CODEX_EXECUTION_FAILED");
}
function environment(host: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_ALLOWLIST) if (host[key]) result[key] = host[key];
  return result;
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function bounded(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length <= MAX_TEXT) return value;
  // The marker must fit inside the MAX_TEXT budget: its length plus the
  // newline separator is deducted from the retained content, so the final
  // string never exceeds MAX_TEXT.
  const retained = MAX_TEXT - TRUNCATION_MARKER.length - 1;
  return `${value.slice(0, retained)}\n${TRUNCATION_MARKER}`;
}

export class CodexExecutor implements Executor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private threadId?: string;
  private turnId: string | undefined;
  private startedTurnId: string | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: () => void }>();

  constructor(private readonly workspaceRoot: string, private readonly startProcess: ProcessStarter = spawn,
    private readonly hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
    private readonly platform: NodeJS.Platform = process.platform) {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    this.turnId = undefined;
    this.startedTurnId = undefined;
    let child: ChildProcessWithoutNullStreams;
    try {
      const options: SpawnOptionsWithoutStdio = {
        cwd: this.workspaceRoot, shell: false, stdio: ["pipe", "pipe", "pipe"], env: environment(this.hostEnvironment)
      };
      // Windows: a directly spawnable codex.exe is preferred; an npm-installed
      // codex.cmd shim is resolved to the official bin/codex.js Node target and
      // launched through Node directly. Nothing here goes through a shell, and
      // the user instruction travels over stdin, never through the command
      // line. Everywhere else (and as the Windows fallback) the original bare
      // "codex" spawn is unchanged.
      const resolved = resolveCommand(this.hostEnvironment, "codex", {
        nodeTarget: CODEX_NODE_TARGET, platform: this.platform
      });
      if (resolved.kind === "direct") {
        child = this.startProcess(resolved.executable, ["app-server", "--stdio"], options);
      } else if (resolved.kind === "node-launcher") {
        child = this.startProcess(process.execPath, [resolved.scriptPath, "app-server", "--stdio"], options);
      } else {
        child = this.startProcess("codex", ["app-server", "--stdio"], options);
      }
      this.child = child;
    } catch { return failure("CODEX_UNAVAILABLE"); }

    const evidence = new Map<string, ExecutorEvidence>();
    let evidenceDropped = 0;
    let output = "";
    let buffer = "";
    let terminal: ((result: ExecutorResult) => void) | undefined;
    let terminalPromise!: Promise<ExecutorResult>;
    terminalPromise = new Promise((resolve) => { terminal = resolve; });
    let settled = false;
    const finish = (result: ExecutorResult): void => {
      if (settled) return;
      settled = true;
      for (const waiter of this.pending.values()) waiter.reject();
      this.pending.clear();
      terminal?.(result);
      if (this.child === child) {
        this.child = undefined;
        this.turnId = undefined;
        this.startedTurnId = undefined;
      }
      if (!child.killed) child.kill();
    };
    const unavailable = (): void => finish(failure("CODEX_UNAVAILABLE"));
    // The evidence view a supervisor receives. Real evidence and the synthetic
    // evidence-drop marker together never exceed MAX_EVIDENCE: the marker only
    // appears once real entries were evicted, and the eviction loop above
    // reserves its slot within the same budget. Rebuilt from a single counter,
    // it can never grow evidence unboundedly.
    const visibleEvidence = (): readonly ExecutorEvidence[] => {
      const items = [...evidence.values()];
      return evidenceDropped === 0
        ? items
        : [...items, {
          id: "evidence-drop",
          type: "commandExecution",
          status: "completed",
          command: `${evidenceDropped} evidence item(s) dropped: evidence limit exceeded`
        }];
    };
    child.on("error", unavailable);
    child.stdin.on("error", unavailable);
    child.stdout.on("error", unavailable);
    child.stderr.on("error", unavailable);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        if (!object(message)) { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        if (typeof message.id === "number" && ("result" in message || "error" in message)) {
          const waiter = this.pending.get(message.id);
          if (waiter) { this.pending.delete(message.id); "error" in message ? waiter.reject() : waiter.resolve(message.result); }
          continue;
        }
        if (typeof message.method !== "string" || !object(message.params)) { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
        if (message.method === "turn/started") {
          const turn = object(message.params.turn) ? message.params.turn : message.params;
          if (message.params.threadId === this.threadId && typeof turn.id === "string" && (!this.turnId || turn.id === this.turnId)) this.startedTurnId = turn.id;
        }
        const item = object(message.params.item) ? message.params.item : undefined;
        if ((message.method === "item/started" || message.method === "item/completed") && item) {
          if (item.type === "agentMessage") {
            if (message.method === "item/completed" && typeof item.text !== "string") { finish(failure("CODEX_PROTOCOL_ERROR")); return; }
            if (typeof item.text === "string") output = item.text;
          }
          const id = typeof item.id === "string" ? item.id : undefined;
          if (id && (item.type === "commandExecution" || item.type === "fileChange")) {
            const status = typeof item.status === "string" ? item.status : message.method === "item/started" ? "inProgress" : "completed";
            let entry: ExecutorEvidence;
            if (item.type === "commandExecution") entry = { id, type: item.type, status, command: bounded(item.command) };
            else {
              const rawChanges = Array.isArray(item.changes) ? item.changes : [];
              // The 50-entry bound includes the synthetic truncation marker: a
              // truncated list keeps 49 real entries and spends the 50th slot
              // on the marker, so the final list never exceeds the bound.
              const kept = rawChanges.length > 50 ? 49 : 50;
              const changes = rawChanges.slice(0, kept).filter(object).map((c) => ({ path: bounded(c.path), diff: bounded(c.diff) }));
              if (rawChanges.length > 50) {
                // omitted counts exactly the real changes that were never
                // returned to the supervisor.
                changes.push({ path: `[truncated: ${rawChanges.length - kept} additional changes omitted]`, diff: "" });
              }
              entry = { id, type: item.type, status, changes };
            }
            evidence.set(id, entry);
            // The MAX_EVIDENCE budget includes the evidence-drop marker: once
            // any drop has happened the marker reserves one slot within the
            // same budget, so the final visible list never exceeds
            // MAX_EVIDENCE entries.
            while (evidence.size + (evidenceDropped > 0 ? 1 : 0) > MAX_EVIDENCE) {
              evidence.delete(evidence.keys().next().value as string);
              evidenceDropped += 1;
            }
            request.onEvidence?.(visibleEvidence());
          }
        }
        if (message.method === "turn/completed") {
          const turn = object(message.params.turn) ? message.params.turn : message.params;
          const status = turn.status;
          const common = { threadId: this.threadId, evidence: visibleEvidence() };
          if (status === "failed") finish({ ...failedTurn(turn), ...common });
          else if (status === "interrupted") finish({ kind: "interrupted", output, ...common });
          else if (status === "completed") finish({ kind: "completed", output, ...common });
          else finish(failure("CODEX_PROTOCOL_ERROR"));
        }
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      if (buffer.trim()) { try { JSON.parse(buffer); } catch { finish(failure("CODEX_PROTOCOL_ERROR")); return; } }
      finish(code === 0 ? failure("CODEX_PROTOCOL_ERROR") : failure("CODEX_EXECUTION_FAILED"));
    });

    try {
      await this.call("initialize", { clientInfo: { name: "engineering-bridge", version: VERSION } });
      this.notify("initialized", {});
      const sandbox = request.sandbox ?? "read-only";
      const threadParams: Record<string, unknown> = { cwd: this.workspaceRoot, approvalPolicy: "never", sandbox };
      if (request.threadId) threadParams.threadId = request.threadId;
      const threadResult = await this.call(request.threadId ? "thread/resume" : "thread/start", threadParams);
      if (!object(threadResult) || !object(threadResult.thread) || typeof threadResult.thread.id !== "string") throw new Error();
      this.threadId = threadResult.thread.id;
      const sandboxPolicy = sandbox === "workspace-write"
        ? { type: "workspaceWrite", writableRoots: [this.workspaceRoot], networkAccess: false }
        : { type: "readOnly", networkAccess: false };
      const turnResult = await this.call("turn/start", { threadId: this.threadId, input: [{ type: "text", text: request.instruction }], cwd: this.workspaceRoot, approvalPolicy: "never", sandboxPolicy });
      if (!object(turnResult) || !object(turnResult.turn) || typeof turnResult.turn.id !== "string") throw new Error();
      this.turnId = turnResult.turn.id;
      if (this.startedTurnId !== this.turnId) this.startedTurnId = undefined;
    } catch { if (!settled) finish(failure("CODEX_PROTOCOL_ERROR")); }
    return terminalPromise;
  }

  async steer(instruction: string): Promise<void> {
    if (!this.threadId || !this.startedTurnId) throw new CoreError("INVALID_STATE_TRANSITION");
    await this.call("turn/steer", { threadId: this.threadId, expectedTurnId: this.startedTurnId, input: [{ type: "text", text: instruction }] });
  }
  async interrupt(): Promise<void> {
    if (!this.threadId || !this.startedTurnId) throw new CoreError("INVALID_STATE_TRANSITION");
    await this.call("turn/interrupt", { threadId: this.threadId, turnId: this.startedTurnId });
  }
  private call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.stdin.destroyed) { reject(); return; }
      this.pending.set(id, { resolve, reject: () => reject(new Error()) });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  private notify(method: string, params: unknown): void { this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`); }
}
