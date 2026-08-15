import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { DshExecutor } from "../../../src/executors/dsh-executor.js";
import type { DshProcessStarter } from "../../../src/executors/dsh-executor.js";
import { isId } from "../../../src/core/ids.js";

const TASK_ID_VALUE = "550e8400-e29b-41d4-a716-446655440000";
if (!isId(TASK_ID_VALUE)) throw new Error("Test task ID must be a UUID v4.");
const TASK_ID = TASK_ID_VALUE;
const TRUSTED_CWD = "/trusted/workspace";

interface Invocation {
  executable: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  stdin: PassThrough;
}

interface FakeBehavior {
  stdout?: string | Buffer;
  stderr?: string;
  exitCode?: number;
  processError?: boolean;
}

function fakeStarter(behavior: FakeBehavior, invocations: Invocation[]): DshProcessStarter {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    invocations.push({ executable, args: [...args], options, stdin });
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill() {
        this.killed = true;
        return true;
      }
    });
    queueMicrotask(() => {
      if (behavior.processError) {
        child.emit("error", new Error("secret process error"));
        return;
      }
      stdout.end(behavior.stdout ?? "final answer\n");
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
    LOGNAME: "tester-log"
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

test("maps malformed completed output to a protocol error", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: "unterminated secret output" }, []),
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
