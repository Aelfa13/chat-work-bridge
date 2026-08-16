import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import { DshExecutor } from "../../../src/executors/dsh-executor.js";
import type { DshProcessStarter } from "../../../src/executors/dsh-executor.js";
import { isId } from "../../../src/core/ids.js";

const TASK_ID_VALUE = "550e8400-e29b-41d4-a716-446655440000";
if (!isId(TASK_ID_VALUE)) throw new Error("Test task ID must be a UUID v4.");
const TASK_ID = TASK_ID_VALUE;
const TRUSTED_CWD = "/trusted/workspace";
const MAX_OUTPUT_BYTES = 1_048_576;
const TRUNCATION_MARKER = "[output truncated]";

interface Invocation {
  executable: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  stdin: PassThrough;
  signals: string[];
  killResult: boolean;
  write(chunk: string | Buffer): void;
  close(code: number | null): void;
}

interface FakeBehavior {
  stdout?: string | Buffer;
  stderr?: string;
  exitCode?: number;
  processError?: boolean;
  hold?: boolean;
}

function fakeStarter(behavior: FakeBehavior, invocations: Invocation[]): DshProcessStarter {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const invocation: Invocation = {
      executable,
      args: [...args],
      options,
      stdin,
      signals: [],
      killResult: true,
      write(chunk) {
        stdout.write(chunk);
      },
      close(code) {
        stdout.end();
        stderr.end();
        child.emit("close", code, null);
      }
    };
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill(signal?: string) {
        this.killed = true;
        invocation.signals.push(signal ?? "SIGTERM");
        return invocation.killResult;
      }
    });
    invocations.push(invocation);
    queueMicrotask(() => {
      if (behavior.processError) {
        child.emit("error", new Error("secret process error"));
        return;
      }
      if (behavior.hold) return;
      if (behavior.stdout !== undefined) stdout.end(behavior.stdout);
      else stdout.end("final answer\n");
      stderr.end(behavior.stderr ?? "");
      child.emit("close", behavior.exitCode ?? 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

test("uses the official headless interface with a fixed workspace and returns final text", async () => {
  const invocations: Invocation[] = [];
  const hostEnvironment = {
    PATH: "/test/bin",
    HOME: "/home/test",
    DSH_HOME: "/dsh/test",
    TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    USER: "tester",
    LOGNAME: "tester-log",
    DSH_PERMISSION_MODE: "danger-full-access",
    DEEPSEEK_API_KEY: "secret-api-key",
    HTTP_PROXY: "secret-proxy"
  };
  const executor = new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: "final answer\n" }, invocations),
    hostEnvironment
  );
  const instruction = "  exact prompt\nwith $() and `quotes`  ";

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction,
    sandbox: "read-only"
  });

  assert.deepEqual(result, { kind: "completed", output: "final answer" });
  assert.equal(invocations.length, 1);
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "dsh");
  assert.deepEqual(invocation.args, ["--profile", "headless", instruction]);
  assert.equal(invocation.options.cwd, TRUSTED_CWD);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(invocation.options.env, {
    PATH: "/test/bin",
    HOME: "/home/test",
    DSH_HOME: "/dsh/test",
    TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    USER: "tester",
    LOGNAME: "tester-log",
    DSH_PERMISSION_MODE: "read-only"
  });
  assert.equal(invocation.stdin.writableEnded, true);
});

test("maps spawn failures to unavailable", async () => {
  const throwing: DshProcessStarter = () => {
    throw new Error("secret spawn details");
  };
  const thrown = await new DshExecutor(TRUSTED_CWD, throwing, {})
    .execute({ taskId: TASK_ID, instruction: "inspect" });
  const emitted = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ processError: true }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  for (const result of [thrown, emitted]) {
    assert.deepEqual(result, {
      kind: "failed",
      error: { code: "DSH_UNAVAILABLE", message: "DSH is unavailable." }
    });
  }
});

test("accepts valid output without a trailing newline", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: "final answer" }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, { kind: "completed", output: "final answer" });
});

test("maps invalid UTF-8 completed output to a protocol error", async () => {
  const stdout = Buffer.concat([
    Buffer.from("secret output "),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("\n")
  ]);
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "DSH_PROTOCOL_ERROR", message: "DSH returned an invalid response." }
  });
  assert.equal(JSON.stringify(result).includes("secret output"), false);
});

test("maps nonzero exit to an execution failure without exposing output or stderr", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({
      stdout: "secret partial\n",
      stderr: "secret stderr /private/path",
      exitCode: 7
    }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "DSH_EXECUTION_FAILED", message: "DSH execution failed." }
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret partial"), false);
  assert.equal(serialized.includes("secret stderr"), false);
  assert.equal(serialized.includes("/private/path"), false);
});

test("does not impose a sandbox policy before starting DSH", async () => {
  const invocations: Invocation[] = [];
  const result = await new DshExecutor(TRUSTED_CWD, fakeStarter({}, invocations), {})
    .execute({ taskId: TASK_ID, instruction: "inspect", sandbox: "workspace-write" });

  assert.deepEqual(result, { kind: "completed", output: "final answer" });
  assert.equal(invocations.length, 1);
});

test("pins DSH read-only permission mode and never forwards the host override or secrets", async () => {
  const invocations: Invocation[] = [];
  const hostEnvironment = {
    PATH: "/test/bin",
    HOME: "/home/test",
    DSH_HOME: "/dsh/test",
    DSH_PERMISSION_MODE: "workspace-write",
    DEEPSEEK_API_KEY: "secret-api-key",
    HTTP_PROXY: "secret-proxy"
  };
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({}, invocations), hostEnvironment);

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, { kind: "completed", output: "final answer" });
  assert.equal(invocations.length, 1);
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.options.env?.DSH_PERMISSION_MODE, "read-only");
  assert.equal(invocation.options.env?.DEEPSEEK_API_KEY, undefined);
  assert.equal(invocation.options.env?.HTTP_PROXY, undefined);
  // The invocation itself is unchanged: same official headless interface.
  assert.deepEqual(invocation.args, ["--profile", "headless", "inspect"]);
});

test("a host requesting danger-full-access cannot override the read-only run_task", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({}, invocations), {
    PATH: "/test/bin",
    HOME: "/home/test",
    DSH_PERMISSION_MODE: "danger-full-access"
  });

  await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.options.env?.DSH_PERMISSION_MODE, "read-only");
});

test("treats exactly 1 MiB of output as within the cap", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: Buffer.alloc(MAX_OUTPUT_BYTES, 0x61) }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, { kind: "completed", output: "a".repeat(MAX_OUTPUT_BYTES) });
  assert.equal(result.output.includes(TRUNCATION_MARKER), false);
});

test("truncates only once output exceeds 1 MiB, keeps the first 1 MiB, and marks the truncation", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: Buffer.alloc(MAX_OUTPUT_BYTES + 1, 0x61) }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, {
    kind: "completed",
    output: `${"a".repeat(MAX_OUTPUT_BYTES)}\n${TRUNCATION_MARKER}`
  });
});

test("keeps draining and waits for the natural close after the output cap is exceeded", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  let settled = false;
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" })
    .then((result) => { settled = true; return result; });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);
  invocation.write("a".repeat(MAX_OUTPUT_BYTES - 1));
  invocation.write("b");
  invocation.write("c".repeat(64));
  await new Promise<void>((resolve) => setImmediate(resolve));

  // The child is still running: nothing is settled early and it is never killed.
  assert.equal(settled, false);
  assert.deepEqual(invocation.signals, []);

  invocation.close(0);
  const result = await pending;

  assert.equal(settled, true);
  assert.deepEqual(result, {
    kind: "completed",
    output: `${"a".repeat(MAX_OUTPUT_BYTES - 1)}b\n${TRUNCATION_MARKER}`
  });
  assert.deepEqual(invocation.signals, []);
});

test("a truncation boundary cutting a multi-byte character still completes with a valid UTF-8 prefix", async () => {
  const middle = Buffer.from("中"); // 3-byte UTF-8: E4 B8 AD
  for (const cut of [1, 2]) {
    const result = await new DshExecutor(
      TRUSTED_CWD,
      fakeStarter({
        stdout: Buffer.concat([Buffer.alloc(MAX_OUTPUT_BYTES - cut, 0x61), middle])
      }, []),
      {}
    ).execute({ taskId: TASK_ID, instruction: "inspect" });

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.equal(result.output, `${"a".repeat(MAX_OUTPUT_BYTES - cut)}\n${TRUNCATION_MARKER}`);
    assert.doesNotThrow(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.output)));
  }
});

test("genuinely invalid UTF-8 before the truncation boundary is still a protocol error", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({
      stdout: Buffer.concat([
        Buffer.from("a".repeat(MAX_OUTPUT_BYTES - 10)),
        Buffer.from([0xff, 0xfe]),
        Buffer.from("b".repeat(13))
      ])
    }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "DSH_PROTOCOL_ERROR", message: "DSH returned an invalid response." }
  });
});

test("sends SIGTERM to the running child and reports the cached partial output on close", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);
  invocation.write("partial answer");
  await executor.interrupt();
  assert.deepEqual(invocation.signals, ["SIGTERM"]);

  invocation.close(7);
  const result = await pending;

  assert.deepEqual(result, { kind: "interrupted", output: "partial answer" });
  await assert.rejects(executor.interrupt(), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
});

test("interrupt with a zero exit code still reports interrupted", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await executor.interrupt();
  invocations[0]?.close(0);

  assert.deepEqual(await pending, { kind: "interrupted", output: "" });
});

test("interrupt without an active child is an invalid state transition", async () => {
  const idle = new DshExecutor(TRUSTED_CWD, fakeStarter({}, []), {});
  await assert.rejects(idle.interrupt(), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");

  const invocations: Invocation[] = [];
  const completed = new DshExecutor(TRUSTED_CWD, fakeStarter({}, invocations), {});
  await completed.execute({ taskId: TASK_ID, instruction: "inspect" });
  await assert.rejects(completed.interrupt(), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
});

test("repeated interrupt is idempotent and sends a single SIGTERM", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await executor.interrupt();
  await executor.interrupt();
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.deepEqual(invocation.signals, ["SIGTERM"]);

  invocation.close(0);
  assert.deepEqual(await pending, { kind: "interrupted", output: "" });
});

test("a failed kill never mislabels the execution as interrupted", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);
  invocation.killResult = false;
  await assert.rejects(executor.interrupt(), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");

  // The child kept running and its natural close settles the execution normally.
  invocation.write("final answer");
  invocation.close(0);
  assert.deepEqual(await pending, { kind: "completed", output: "final answer" });
});
