import { constants, accessSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError, serializeError } from "../core/errors.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "./executor.js";

export type DshProcessStarter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

const ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "DSH_HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME"
] as const;
const MAX_OUTPUT_BYTES = 1_048_576;

function failure(code: "DSH_UNAVAILABLE" | "DSH_PROTOCOL_ERROR" | "DSH_EXECUTION_FAILED"): ExecutorResult {
  return { kind: "failed", error: serializeError(new CoreError(code)) };
}

function environment(host: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_ALLOWLIST) if (host[key]) result[key] = host[key];
  return result;
}

function executableOnPath(host: Readonly<NodeJS.ProcessEnv>): string | undefined {
  for (const entry of host.PATH?.split(delimiter) ?? []) {
    if (!isAbsolute(entry)) continue;
    const candidate = join(entry, "dsh");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next fixed PATH entry.
    }
  }
  return undefined;
}

function installedRcLauncher(host: Readonly<NodeJS.ProcessEnv>): string | undefined {
  const home = host.DSH_HOME
    ? resolve(host.DSH_HOME)
    : host.HOME
      ? join(resolve(host.HOME), ".dsh")
      : undefined;
  if (!home) return undefined;
  const launcher = join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  try {
    return statSync(launcher).isFile() ? launcher : undefined;
  } catch {
    return undefined;
  }
}

function invocation(host: Readonly<NodeJS.ProcessEnv>): { executable: string; args: string[] } {
  const args = ["--profile", "headless"];
  const executable = executableOnPath(host);
  if (executable) return { executable, args };
  const launcher = installedRcLauncher(host);
  return launcher
    ? { executable: process.execPath, args: [launcher, ...args] }
    : { executable: "dsh", args };
}

export class DshExecutor implements Executor {
  constructor(
    private readonly workspaceRoot: string,
    private readonly startProcess: DshProcessStarter = spawn,
    private readonly hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env
  ) {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const command = invocation(this.hostEnvironment);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.startProcess(command.executable, [...command.args, request.instruction], {
        cwd: this.workspaceRoot,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: environment(this.hostEnvironment)
      });
    } catch {
      return failure("DSH_UNAVAILABLE");
    }

    return new Promise<ExecutorResult>((resolveResult) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (result: ExecutorResult): void => {
        if (settled) return;
        settled = true;
        resolveResult(result);
      };
      const stop = (result: ExecutorResult): void => {
        if (!child.killed) child.kill();
        finish(result);
      };

      child.on("error", () => stop(failure("DSH_UNAVAILABLE")));
      child.stdin.on("error", () => stop(failure("DSH_UNAVAILABLE")));
      child.stdout.on("error", () => stop(failure("DSH_PROTOCOL_ERROR")));
      child.stderr.on("error", () => stop(failure("DSH_EXECUTION_FAILED")));
      child.stderr.resume();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          stop(failure("DSH_PROTOCOL_ERROR"));
          return;
        }
        chunks.push(chunk);
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(failure("DSH_EXECUTION_FAILED"));
          return;
        }
        if (bytes === 0) {
          finish(failure("DSH_PROTOCOL_ERROR"));
          return;
        }
        try {
          const output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          finish(output.endsWith("\n")
            ? { kind: "completed", output: output.slice(0, -1) }
            : failure("DSH_PROTOCOL_ERROR"));
        } catch {
          finish(failure("DSH_PROTOCOL_ERROR"));
        }
      });
      child.stdin.end();
    });
  }
}
