import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from "node:child_process";

const MAX_OUTPUT_TAIL_BYTES = 65_536;

export type ValidationProcessOutcome =
  | {
      readonly kind: "exit";
      readonly exitCode: number;
      readonly durationMs: number;
      readonly outputTail: string;
    }
  | {
      readonly kind: "timeout" | "spawn_error" | "signal" | "termination_error";
      readonly durationMs: number;
      readonly outputTail: string;
    };

export interface ValidationProcessRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly input?: string;
}

export type ValidationProcessStarter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export interface ValidationTimer {
  now(): number;
  set(callback: () => void, delayMs: number): NodeJS.Timeout;
  clear(handle: NodeJS.Timeout): void;
}

const startProcess: ValidationProcessStarter = (executable, args, options) =>
  spawn(executable, args, options);

const systemTimer: ValidationTimer = {
  now: () => Date.now(),
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle)
};

function appendTail(current: Buffer, chunk: Buffer | string): Buffer {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

  if (incoming.length >= MAX_OUTPUT_TAIL_BYTES) {
    return Buffer.from(incoming.subarray(incoming.length - MAX_OUTPUT_TAIL_BYTES));
  }

  const retainedBytes = Math.min(
    current.length,
    MAX_OUTPUT_TAIL_BYTES - incoming.length
  );
  return Buffer.concat([
    current.subarray(current.length - retainedBytes),
    incoming
  ]);
}

function decodeTail(tail: Buffer): string {
  let start = 0;
  while (start < tail.length && (tail[start]! & 0xc0) === 0x80) {
    start++;
  }

  let end = tail.length;
  let lead = end - 1;
  while (lead >= start && (tail[lead]! & 0xc0) === 0x80) {
    lead--;
  }

  if (lead >= start) {
    const leadByte = tail[lead]!;
    const continuationBytes = end - lead - 1;
    const expectedContinuationBytes =
      leadByte >= 0xf0 && leadByte <= 0xf4 ? 3 :
      leadByte >= 0xe0 && leadByte <= 0xef ? 2 :
      leadByte >= 0xc2 && leadByte <= 0xdf ? 1 :
      0;

    if (
      expectedContinuationBytes > 0 &&
      continuationBytes < expectedContinuationBytes
    ) {
      end = lead;
    }
  }

  return tail.subarray(start, end).toString("utf8");
}

type Completion =
  | { readonly kind: "exit"; readonly exitCode: number }
  | { readonly kind: "timeout" | "spawn_error" | "signal" };

export class ValidationProcessRunner {
  constructor(
    private readonly start: ValidationProcessStarter = startProcess,
    private readonly timer: ValidationTimer = systemTimer
  ) {}

  run(request: ValidationProcessRequest): Promise<ValidationProcessOutcome> {
    const startedAt = this.timer.now();

    return new Promise((resolve) => {
      let completed = false;
      let outputTail = Buffer.alloc(0);
      let timeoutHandle: NodeJS.Timeout | undefined;

      const complete = (completion: Completion): void => {
        if (completed) {
          return;
        }
        completed = true;

        if (timeoutHandle !== undefined) {
          this.timer.clear(timeoutHandle);
        }

        const durationMs = this.timer.now() - startedAt;
        const normalizedTail = decodeTail(outputTail);

        if (completion.kind === "exit") {
          resolve({
            kind: "exit",
            exitCode: completion.exitCode,
            durationMs,
            outputTail: normalizedTail
          });
          return;
        }

        resolve({
          kind: completion.kind,
          durationMs,
          outputTail: normalizedTail
        });
      };

      const [executable, ...args] = request.argv;
      let child: ChildProcessWithoutNullStreams;

      try {
        child = this.start(executable, args, {
          cwd: request.cwd,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch {
        complete({ kind: "spawn_error" });
        return;
      }

      const capture = (chunk: Buffer | string): void => {
        if (!completed) {
          outputTail = appendTail(outputTail, chunk);
        }
      };

      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("error", () => complete({ kind: "spawn_error" }));
      child.on("close", (exitCode) => {
        complete(
          typeof exitCode === "number"
            ? { kind: "exit", exitCode }
            : { kind: "signal" }
        );
      });

      timeoutHandle = this.timer.set(() => {
        complete({ kind: "timeout" });
        try {
          child.kill();
        } catch {
          // Timeout classification is already final; killing is best-effort.
        }
      }, request.timeoutMs);

      if (request.input !== undefined) {
        child.stdin.write(request.input);
      }
      child.stdin.end();
    });
  }
}
