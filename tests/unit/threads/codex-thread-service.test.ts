import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import type { Id } from "../../../src/core/ids.js";
import { CodexThreadService, type CodexThreadServiceTiming } from "../../../src/threads/codex-thread-service.js";
import type { ProcessStarter } from "../../../src/executors/codex-executor.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const TASK_ID = "550e8400-e29b-41d4-a716-446655440000" as Id;

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface Invocation {
  readonly calls: Call[];
  readonly signals: string[];
}

interface FakeServerOptions {
  readonly list?: readonly Record<string, unknown>[];
  readonly sourceThread?: Record<string, unknown>;
  readonly forkThread?: Record<string, unknown>;
  readonly turnOutputs?: readonly string[];
  readonly responses?: Readonly<Record<string, unknown>>;
  readonly suppressTurnCompletion?: boolean;
  readonly exitAfterTurnStart?: boolean;
}

function root(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-thread-")));
}

function sourceThread(workspaceRoot: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "source-1",
    cwd: workspaceRoot,
    name: "Desktop source",
    preview: "source preview",
    source: "vscode",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "notLoaded" },
    ephemeral: false,
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [
          { id: "user-1", type: "userMessage", content: [{ type: "text", text: "inspect this project" }] },
          { id: "cmd-1", type: "commandExecution", command: "secret command", aggregatedOutput: "secret stderr" },
          { id: "change-1", type: "fileChange", changes: [{ path: "secret.ts", diff: "secret diff" }] },
          { id: "agent-1", type: "agentMessage", text: "previous answer" }
        ]
      }
    ],
    ...overrides
  };
}

function fakeStarter(
  workspaceRoot: string,
  options: FakeServerOptions,
  invocations: Invocation[]
): ProcessStarter {
  return (_executable, _args, _spawnOptions) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const invocation: Invocation = { calls: [], signals: [] };
    invocations.push(invocation);
    const thread = options.sourceThread ?? sourceThread(workspaceRoot);
    const fork = options.forkThread ?? {
      id: "worker-1",
      cwd: workspaceRoot,
      forkedFromId: "source-1",
      ephemeral: true
    };
    let turnNumber = 0;
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString()) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined) {
          callback();
          return;
        }
        const params = message.params ?? {};
        invocation.calls.push({ method: message.method, params });
        let result: unknown = {};
        if (options.responses !== undefined && Object.prototype.hasOwnProperty.call(options.responses, message.method)) {
          result = options.responses[message.method];
        } else if (message.method === "thread/list") {
          result = { data: options.list ?? [thread], nextCursor: null };
        } else if (message.method === "thread/read") {
          result = { thread };
        } else if (message.method === "thread/fork") {
          result = { thread: fork };
        } else if (message.method === "model/list") {
          result = {
            data: [{
              model: "gpt-test",
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "low" }]
            }]
          };
        } else if (message.method === "turn/start") {
          turnNumber += 1;
          const turnId = "worker-turn-" + turnNumber;
          result = { turn: { id: turnId, status: "inProgress", items: [], error: null } };
          if (!options.suppressTurnCompletion) {
            queueMicrotask(() => {
              stdout.write(JSON.stringify({
                method: "turn/started",
                params: { threadId: "worker-1", turn: { id: turnId, status: "inProgress" } }
              }) + "\n");
              stdout.write(JSON.stringify({
                method: "item/completed",
                params: {
                  threadId: "worker-1",
                  turnId,
                  item: {
                    id: "message-" + turnNumber,
                    type: "agentMessage",
                    text: options.turnOutputs?.[turnNumber - 1] ?? "worker output " + turnNumber
                  }
                }
              }) + "\n");
              stdout.write(JSON.stringify({
                method: "turn/completed",
                params: { threadId: "worker-1", turnId, turn: { id: turnId, status: "completed" } }
              }) + "\n");
            });
          }
          if (options.exitAfterTurnStart) {
            setImmediate(() => child.emit("exit", 1, null));
          }
        } else if (message.method === "turn/steer") {
          result = { turnId: params.expectedTurnId };
        }
        queueMicrotask(() => {
          stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
        });
        callback();
      }
    });
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      killed: false,
      pid: undefined,
      kill(signal?: string) {
        this.killed = true;
        invocation.signals.push(signal ?? "SIGTERM");
        return true;
      }
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

function makeService(
  workspaceRoot: string,
  options: FakeServerOptions = {},
  invocations: Invocation[] = [],
  timingOverrides: Partial<CodexThreadServiceTiming> = {}
): { service: CodexThreadService; invocations: Invocation[] } {
  const registry = new RegisteredWorkspaceRegistry([{ id: "known", root: workspaceRoot }]);
  return {
    service: new CodexThreadService(
      registry,
      fakeStarter(workspaceRoot, options, invocations),
      {},
      "win32",
      {
        executionTimeoutMs: 200,
        interruptGraceMs: 20,
        killGraceMs: 20,
        protocolInactivityTimeoutMs: 100,
        rpcCallTimeoutMs: 100,
        ...timingOverrides
      }
    ),
    invocations
  };
}

function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(action, (error: unknown) =>
    error instanceof CoreError && error.code === code
  ).then(() => undefined);
}

test("listThreads sends the canonical workspace cwd and returns bounded metadata only", async () => {
  const workspaceRoot = root();
  const invocations: Invocation[] = [];
  const { service } = makeService(workspaceRoot, {
    list: [{
      ...sourceThread(workspaceRoot),
      sessionId: "must-not-leak",
      items: [{ type: "commandExecution", command: "must-not-leak" }],
      preview: "preview"
    }]
  }, invocations);

  const result = await service.listThreads({ workspace_id: "known", limit: 1 });

  assert.equal(result.threads.length, 1);
  assert.deepEqual(result.threads[0], {
    thread_id: "source-1",
    name: "Desktop source",
    preview: "preview",
    created_at: 1,
    updated_at: 2,
    source_kind: "vscode",
    status: "notLoaded",
    ephemeral: false
  });
  assert.equal(JSON.stringify(result).includes("sessionId"), false);
  assert.deepEqual(invocations[0]?.calls[1], {
    method: "thread/list",
    params: { cwd: workspaceRoot, limit: 1 }
  });
  assert.ok(invocations[0]?.signals.length);
});

test("listThreads preserves safe pagination and whitelisted source kinds", async () => {
  const workspaceRoot = root();
  const invocations: Invocation[] = [];
  const { service } = makeService(workspaceRoot, {
    list: [sourceThread(workspaceRoot)]
  }, invocations);

  const result = await service.listThreads({
    workspace_id: "known",
    cursor: "next-page",
    source_kinds: ["vscode"]
  });

  assert.deepEqual(result, {
    threads: [{
      thread_id: "source-1",
      name: "Desktop source",
      preview: "source preview",
      created_at: 1,
      updated_at: 2,
      source_kind: "vscode",
      status: "notLoaded",
      ephemeral: false
    }]
  });
  assert.deepEqual(invocations[0]?.calls[1], {
    method: "thread/list",
    params: {
      cwd: workspaceRoot,
      limit: 20,
      cursor: "next-page",
      sourceKinds: ["vscode"]
    }
  });
});

test("listThreads omits threads returned for a foreign workspace", async () => {
  const workspaceRoot = root();
  const { service } = makeService(workspaceRoot, {
    list: [
      sourceThread(workspaceRoot),
      sourceThread(root(), { id: "foreign-1" })
    ]
  });

  const result = await service.listThreads({ workspace_id: "known" });

  assert.deepEqual(result.threads.map((thread) => thread.thread_id), ["source-1"]);
});

test("list and read fail closed on malformed app-server responses", async () => {
  const workspaceRoot = root();
  const { service: malformedList } = makeService(workspaceRoot, {
    responses: { "thread/list": { data: {} } }
  });
  await expectCode(
    () => malformedList.listThreads({ workspace_id: "known" }),
    "CODEX_PROTOCOL_ERROR"
  );

  const { service: malformedRead } = makeService(workspaceRoot, {
    responses: { "thread/read": { thread: {} } }
  });
  await expectCode(
    () => malformedRead.readThread({ workspace_id: "known", thread_id: "source-1" }),
    "CODEX_PROTOCOL_ERROR"
  );
});

test("readThread exposes only bounded user and assistant text", async () => {
  const workspaceRoot = root();
  const longText = "x".repeat(20_000);
  const { service } = makeService(workspaceRoot, {
    sourceThread: sourceThread(workspaceRoot, {
      turns: Array.from({ length: 6 }, (_, index) => ({
        id: "turn-" + index,
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: longText }] },
          { type: "commandExecution", command: "secret command", stderr: "secret stderr" },
          { type: "fileChange", changes: [{ path: "secret", diff: "secret diff" }] },
          { type: "agentMessage", text: longText }
        ]
      }))
    })
  });

  const result = await service.readThread({ workspace_id: "known", thread_id: "source-1" });

  assert.equal(result.turns.length, 5);
  assert.equal(result.truncated, true);
  assert.equal(result.truncation, "[truncated]");
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 16_384);
  assert.equal(JSON.stringify(result).includes("secret command"), false);
  assert.equal(JSON.stringify(result).includes("secret diff"), false);
  assert.equal(result.turns.some((turn) => turn.user_text?.endsWith("[truncated]") === true), true);
});

test("readThread fails closed when the app-server returns a foreign cwd", async () => {
  const workspaceRoot = root();
  const { service } = makeService(workspaceRoot, {
    sourceThread: sourceThread(workspaceRoot, { cwd: root() })
  });

  await expectCode(
    () => service.readThread({ workspace_id: "known", thread_id: "source-1" }),
    "WORKSPACE_BOUNDARY_VIOLATION"
  );
});

test("readThread fails closed when cwd is missing", async () => {
  const workspaceRoot = root();
  const { service } = makeService(workspaceRoot, {
    sourceThread: sourceThread(workspaceRoot, { cwd: undefined })
  });

  await expectCode(
    () => service.readThread({ workspace_id: "known", thread_id: "source-1" }),
    "WORKSPACE_BOUNDARY_VIOLATION"
  );
});

test("startWorker rejects active sources before fork", async () => {
  const workspaceRoot = root();
  const invocations: Invocation[] = [];
  const { service } = makeService(workspaceRoot, {
    sourceThread: sourceThread(workspaceRoot, { status: { type: "active", activeFlags: [] } })
  }, invocations);

  await expectCode(
    () => service.startWorker({
      workspace_id: "known",
      source_thread_id: "source-1",
      instruction: "inspect"
    }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  assert.equal(invocations[0]?.calls.some(({ method }) => method === "thread/fork"), false);
});

test("startWorker rejects unknown source status before fork", async () => {
  const workspaceRoot = root();
  const invocations: Invocation[] = [];
  const { service } = makeService(workspaceRoot, {
    sourceThread: sourceThread(workspaceRoot, { status: { type: "futureStatus" } })
  }, invocations);

  await expectCode(
    () => service.startWorker({
      workspace_id: "known",
      source_thread_id: "source-1",
      instruction: "inspect"
    }),
    "CODEX_PROTOCOL_ERROR"
  );
  assert.equal(invocations[0]?.calls.some(({ method }) => method === "thread/fork"), false);
});

test("startWorker rejects malformed, same-id, mismatched, and non-ephemeral forks", async () => {
  const forks = [
    {},
    { id: "source-1", forkedFromId: "source-1", ephemeral: true },
    { id: "worker-1", forkedFromId: "other-source", ephemeral: true },
    { id: "worker-1", forkedFromId: "source-1", ephemeral: false }
  ];
  for (const forkThread of forks) {
    const workspaceRoot = root();
    const { service } = makeService(workspaceRoot, { forkThread });
    await expectCode(
      () => service.startWorker({
        workspace_id: "known",
        source_thread_id: "source-1",
        instruction: "inspect"
      }),
      "CODEX_PROTOCOL_ERROR"
    );
  }
});

test("startWorker forces an ephemeral fork and reuses one app-server for two turns", async () => {
  const workspaceRoot = root();
  const invocations: Invocation[] = [];
  const { service } = makeService(workspaceRoot, {
    turnOutputs: ["first", "second"]
  }, invocations);

  const worker = await service.startWorker({
    workspace_id: "known",
    source_thread_id: "source-1",
    instruction: "first"
  });
  const first = await worker.run(TASK_ID, "first");
  const second = await worker.run(TASK_ID, "second");

  assert.equal(invocations.length, 1);
  assert.equal(first.kind, "completed");
  assert.equal(second.kind, "completed");
  if (first.kind === "completed" && second.kind === "completed") {
    assert.equal(first.output, "first");
    assert.equal(second.output, "second");
  }
  assert.equal(invocations[0]?.calls.some(({ method }) => method === "thread/resume"), false);
  assert.deepEqual(invocations[0]?.calls.find(({ method }) => method === "thread/fork")?.params, {
    threadId: "source-1",
    ephemeral: true
  });
  const turns = invocations[0]?.calls.filter(({ method }) => method === "turn/start");
  assert.equal(turns?.length, 2);
  assert.equal(turns?.[0]?.params.sandboxPolicy && JSON.stringify(turns[0].params.sandboxPolicy), JSON.stringify({
    type: "readOnly",
    networkAccess: false
  }));
  assert.equal(turns?.[0]?.params.approvalPolicy, "never");
  assert.equal("permissions" in (turns?.[0]?.params ?? {}), false);
  assert.equal("capabilities" in (turns?.[0]?.params ?? {}), false);
  assert.equal("readOnly" in (turns?.[0]?.params ?? {}), false);
  assert.equal(JSON.stringify(turns?.[0]?.params).includes("workspace-write"), false);
  assert.equal(JSON.stringify(turns?.[0]?.params).includes("danger-full-access"), false);
  await worker.close();
});

test("worker hard deadline, inactivity deadline, and app-server exit settle with cleanup", async () => {
  const stalledRoot = root();
  const stalledInvocations: Invocation[] = [];
  const { service: stalledService } = makeService(stalledRoot, {
    suppressTurnCompletion: true
  }, stalledInvocations, {
    executionTimeoutMs: 50,
    protocolInactivityTimeoutMs: 1_000
  });
  const stalledWorker = await stalledService.startWorker({
    workspace_id: "known",
    source_thread_id: "source-1",
    instruction: "stall"
  });
  const stalled = await stalledWorker.run(TASK_ID, "stall");
  assert.equal(stalled.kind, "failed");
  if (stalled.kind === "failed") assert.equal(stalled.error.code, "CODEX_EXECUTION_FAILED");
  await stalledWorker.close();
  assert.ok(stalledInvocations[0]?.signals.length);

  const exitRoot = root();
  const exitInvocations: Invocation[] = [];
  const { service: exitService } = makeService(exitRoot, {
    suppressTurnCompletion: true,
    exitAfterTurnStart: true
  }, exitInvocations);
  const exitWorker = await exitService.startWorker({
    workspace_id: "known",
    source_thread_id: "source-1",
    instruction: "exit"
  });
  const exited = await exitWorker.run(TASK_ID, "exit");
  assert.equal(exited.kind, "failed");
  if (exited.kind === "failed") assert.equal(exited.error.code, "CODEX_PROTOCOL_ERROR");
  await exitWorker.close();
  assert.ok(exitInvocations[0]?.signals.length);
});
