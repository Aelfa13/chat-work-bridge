import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError, serializeError } from "../core/errors.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "./executor.js";

export type ProcessStarter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

const ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "CODEX_HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME"
] as const;

function safeFailure(code: "CODEX_UNAVAILABLE" | "CODEX_PROTOCOL_ERROR" | "CODEX_EXECUTION_FAILED"): ExecutorResult {
  return { kind: "failed", error: serializeError(new CoreError(code)) };
}

function minimalEnvironment(hostEnvironment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const value = hostEnvironment[name];
    if (value !== undefined && value.length > 0) {
      environment[name] = value;
    }
  }
  return environment;
}

function parseOutput(stdout: string): ExecutorResult {
  const messages: string[] = [];

  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return safeFailure("CODEX_PROTOCOL_ERROR");
    }

    if (typeof event !== "object" || event === null || !("type" in event) || typeof event.type !== "string") {
      return safeFailure("CODEX_PROTOCOL_ERROR");
    }
    if (event.type !== "item.completed") continue;
    if (!("item" in event) || typeof event.item !== "object" || event.item === null ||
        !("type" in event.item) || typeof event.item.type !== "string") {
      return safeFailure("CODEX_PROTOCOL_ERROR");
    }
    if (event.item.type !== "agent_message") continue;
    if (!("text" in event.item) || typeof event.item.text !== "string") {
      return safeFailure("CODEX_PROTOCOL_ERROR");
    }
    messages.push(event.item.text);
  }

  return messages.length === 0
    ? safeFailure("CODEX_PROTOCOL_ERROR")
    : { kind: "completed", output: messages.join("\n") };
}

export class CodexExecutor implements Executor {
  constructor(
    private readonly trustedCwd: string,
    private readonly startProcess: ProcessStarter = spawn,
    private readonly hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env
  ) {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const args = [
      "-a", "never",
      "exec",
      "--sandbox", "read-only",
      "--ephemeral",
      "--json",
      "--cd", this.trustedCwd,
      "--ignore-user-config",
      "--strict-config",
      "-c", "sandbox_workspace_write.network_access=false",
      "-"
    ] as const;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.startProcess("codex", args, {
        cwd: this.trustedCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: minimalEnvironment(this.hostEnvironment)
      });
    } catch {
      return safeFailure("CODEX_UNAVAILABLE");
    }

    return new Promise((resolve) => {
      let stdout = "";
      let settled = false;
      const finish = (result: ExecutorResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stdout.on("error", () => finish(safeFailure("CODEX_UNAVAILABLE")));
      child.stderr.on("error", () => finish(safeFailure("CODEX_UNAVAILABLE")));
      child.stderr.resume();
      child.stdin.on("error", () => finish(safeFailure("CODEX_UNAVAILABLE")));
      child.on("error", () => finish(safeFailure("CODEX_UNAVAILABLE")));
      child.on("close", (code) => {
        if (code !== 0) {
          finish(safeFailure("CODEX_EXECUTION_FAILED"));
          return;
        }
        finish(parseOutput(stdout));
      });
      child.stdin.end(request.instruction);
    });
  }
}
