import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { isId } from "../../../src/core/ids.js";
import { CodexExecutor } from "../../../src/executors/codex-executor.js";
import type { ProcessStarter } from "../../../src/executors/codex-executor.js";

const TASK_ID_VALUE = "550e8400-e29b-41d4-a716-446655440000";
if (!isId(TASK_ID_VALUE)) throw new Error("Test task ID must be a UUID v4.");
const TASK_ID = TASK_ID_VALUE;
const TRUSTED_CWD = "/trusted/workspace";

interface Invocation {
  executable: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  stdin: string;
}

interface FakeBehavior {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  processError?: boolean;
}

function fakeStarter(behavior: FakeBehavior, invocations: Invocation[]): ProcessStarter {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const invocation: Invocation = { executable, args: [...args], options, stdin: "" };
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        invocation.stdin += chunk.toString();
        callback();
      }
    });
    invocations.push(invocation);
    Object.assign(child, { stdin, stdout, stderr });

    queueMicrotask(() => {
      if (behavior.processError === true) {
        child.emit("error", new Error("secret process error"));
        return;
      }
      stdout.end(behavior.stdout ?? "");
      stderr.end(behavior.stderr ?? "");
      child.emit("close", behavior.exitCode ?? 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

test("uses the fixed safe invocation and returns agent text", async () => {
  const invocations: Invocation[] = [];
  const hostEnvironment = {
    PATH: "/bin",
    HOME: "/home/test",
    CODEX_HOME: "/codex/test",
    TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    USER: "tester",
    LOGNAME: "tester-log",
    OPENAI_API_KEY: "secret-api-key",
    HTTP_PROXY: "secret-proxy",
    SSH_AUTH_SOCK: "secret-ssh",
    EMPTY_ALLOWED: ""
  };
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "ignored" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } })
    ].join("\n")
  }, invocations), hostEnvironment);
  const instruction = "  exact prompt\nwith $() and `quotes`  ";

  assert.deepEqual(await executor.execute({ taskId: TASK_ID, instruction }), {
    kind: "completed", output: "final answer"
  });
  assert.equal(invocations.length, 1);
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "codex");
  assert.deepEqual(invocation.args, [
    "-a", "never", "exec", "--sandbox", "read-only", "--ephemeral", "--json",
    "--cd", TRUSTED_CWD, "--ignore-user-config", "--strict-config",
    "-c", "sandbox_workspace_write.network_access=false", "-"
  ]);
  assert.equal(invocation.args.includes("network_access=false"), false);
  assert.equal(invocation.options.cwd, TRUSTED_CWD);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(invocation.options.env, {
    PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/codex/test", TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8", LC_ALL: "C", USER: "tester", LOGNAME: "tester-log"
  });
  assert.equal(invocation.stdin, instruction);
  assert.equal(invocation.args.includes(instruction), false);
});

test("maps a thrown spawn and a process error to unavailable", async () => {
  const throwing: ProcessStarter = () => { throw new Error("secret spawn details"); };
  const thrown = await new CodexExecutor(TRUSTED_CWD, throwing, {}).execute({ taskId: TASK_ID, instruction: "x" });
  const emitted = await new CodexExecutor(TRUSTED_CWD, fakeStarter({ processError: true }, []), {})
    .execute({ taskId: TASK_ID, instruction: "x" });

  for (const result of [thrown, emitted]) {
    assert.deepEqual(result, {
      kind: "failed",
      error: { code: "CODEX_UNAVAILABLE", message: "Codex is unavailable." }
    });
  }
});

test("rejects malformed JSONL, missing messages, and malformed message structure", async () => {
  const outputs = [
    "not-json secret raw line",
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message" } })
  ];
  for (const stdout of outputs) {
    const result = await new CodexExecutor(TRUSTED_CWD, fakeStarter({ stdout }, []), {})
      .execute({ taskId: TASK_ID, instruction: "x" });
    assert.deepEqual(result, {
      kind: "failed",
      error: { code: "CODEX_PROTOCOL_ERROR", message: "Codex returned an invalid response." }
    });
    assert.equal(JSON.stringify(result).includes("secret raw line"), false);
  }
});

test("nonzero exit discards partial output and stderr details", async () => {
  const result = await new CodexExecutor(TRUSTED_CWD, fakeStarter({
    stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "secret partial" } }),
    stderr: "secret stderr /private/path",
    exitCode: 7
  }, []), {}).execute({ taskId: TASK_ID, instruction: "x" });

  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret partial"), false);
  assert.equal(serialized.includes("secret stderr"), false);
  assert.equal(serialized.includes("/private/path"), false);
});
