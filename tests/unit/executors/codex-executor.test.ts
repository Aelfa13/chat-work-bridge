import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import { isId } from "../../../src/core/ids.js";
import { CodexExecutor } from "../../../src/executors/codex-executor.js";
import type { ProcessStarter } from "../../../src/executors/codex-executor.js";
import { VERSION } from "../../../src/version.js";

const TASK_ID_VALUE = "550e8400-e29b-41d4-a716-446655440000";
if (!isId(TASK_ID_VALUE)) throw new Error("Test task ID must be a UUID v4.");
const TASK_ID = TASK_ID_VALUE;
const TRUSTED_CWD = "/trusted/workspace";

interface Invocation {
  executable: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  stdin: string;
  send(message: unknown): void;
}

interface FakeBehavior {
  appServerOutput?: string;
  turnError?: { message: string; codexErrorInfo?: string; additionalDetails?: string };
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  processError?: boolean;
  autoComplete?: boolean;
}

function fakeStarter(behavior: FakeBehavior, invocations: Invocation[]): ProcessStarter {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const invocation: Invocation = {
      executable, args: [...args], options, stdin: "",
      send(message) { stdout.write(`${JSON.stringify(message)}\n`); }
    };
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        invocation.stdin += chunk.toString();
        if (behavior.appServerOutput !== undefined) {
          const message = JSON.parse(chunk.toString()) as { id?: number; method: string };
          if (message.id !== undefined) {
            let result: unknown = {};
            if (message.method === "thread/start") result = { thread: { id: "thread-1" } };
            if (message.method === "turn/start") result = { turn: { id: "turn-1" } };
            queueMicrotask(() => {
              stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
              if (message.method === "turn/start" && behavior.autoComplete !== false) {
                stdout.write(`${JSON.stringify({ method: "item/completed", params: { item: { id: "message-1", type: "agentMessage", text: behavior.appServerOutput } } })}\n`);
                const status = behavior.turnError ? "failed" : "completed";
                stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status, error: behavior.turnError } } })}\n`);
              }
            });
          }
        }
        callback();
      }
    });
    invocations.push(invocation);
    Object.assign(child, { stdin, stdout, stderr, killed: false, kill() { this.killed = true; return true; } });

    queueMicrotask(() => {
      if (behavior.appServerOutput !== undefined) return;
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
    appServerOutput: "final answer"
  }, invocations), hostEnvironment);
  const instruction = "  exact prompt\nwith $() and `quotes`  ";

  const result = await executor.execute({ taskId: TASK_ID, instruction });
  assert.equal(result.kind, "completed");
  if (result.kind === "completed") assert.equal(result.output, "final answer");
  assert.equal(invocations.length, 1);
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "codex");
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
  assert.equal(invocation.options.cwd, TRUSTED_CWD);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(invocation.options.env, {
    PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/codex/test", TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8", LC_ALL: "C", USER: "tester", LOGNAME: "tester-log"
  });
  const messages = invocation.stdin.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages[0], { id: 1, method: "initialize", params: { clientInfo: { name: "engineering-bridge", version: VERSION } } });
  assert.deepEqual(messages[1], { method: "initialized", params: {} });
  assert.deepEqual(messages[2], { id: 2, method: "thread/start", params: { cwd: TRUSTED_CWD, approvalPolicy: "never", sandbox: "read-only" } });
  assert.deepEqual(messages[3], { id: 3, method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: instruction }], cwd: TRUSTED_CWD, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } } });
  assert.equal(invocation.args.includes(instruction), false);
});

test("controls require turn/started readiness and reset between turns", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});

  const firstExecution = executor.execute({ taskId: TASK_ID, instruction: "first" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(executor.steer("too soon"), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  await assert.rejects(executor.interrupt(), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/steer"'), false);
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/interrupt"'), false);

  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "other-turn", status: "inProgress" } } });
  await assert.rejects(executor.interrupt(), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/interrupt"'), false);

  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  await executor.steer("continue");
  await executor.interrupt();
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/steer"'), true);
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/interrupt"'), true);

  invocations[0]?.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  await firstExecution;
  await assert.rejects(executor.interrupt(), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");

  const secondExecution = executor.execute({ taskId: TASK_ID, threadId: "thread-1", instruction: "second" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(executor.steer("too soon again"), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  assert.equal(invocations[1]?.stdin.includes('"method":"turn/steer"'), false);
  invocations[1]?.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  await secondExecution;
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

test("reports an allowlisted failed-turn reason without exposing raw error details", async () => {
  const result = await new CodexExecutor(TRUSTED_CWD, fakeStarter({
    appServerOutput: "",
    turnError: {
      message: "secret upstream message /private/path",
      codexErrorInfo: "serverOverloaded",
      additionalDetails: "secret diagnostics"
    }
  }, []), {}).execute({ taskId: TASK_ID, instruction: "x" });

  assert.deepEqual(result, {
    kind: "failed",
    error: {
      code: "CODEX_EXECUTION_FAILED",
      message: "Codex execution failed: the selected model is at capacity."
    },
    threadId: "thread-1",
    evidence: []
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret upstream message"), false);
  assert.equal(serialized.includes("/private/path"), false);
  assert.equal(serialized.includes("secret diagnostics"), false);
});
