import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreError, serializeError } from "../../../src/core/errors.js";
import type { Id } from "../../../src/core/ids.js";
import type { ExecutorEvidence, ExecutorResult } from "../../../src/executors/executor.js";
import {
  RegisteredWorkspaceTaskService
} from "../../../src/tasks/registered-workspace-task-service.js";
import type {
  CodexThreadAudit,
  CodexThreadTaskRequest,
  CodexThreadWorkerSession
} from "../../../src/threads/codex-thread-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const TASK_ID = "550e8400-e29b-41d4-a716-446655440000" as Id;

function workspaceRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-task-")));
}

async function waitForReady(
  service: RegisteredWorkspaceTaskService,
  taskId: string
): Promise<void> {
  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class FakeWorker implements CodexThreadWorkerSession {
  readonly sourceThreadId = "source-1";
  readonly workerThreadId = "worker-1";
  readonly workerSessionId = "worker-session-1";
  readonly runCalls: Array<{ taskId: Id; instruction: string }> = [];
  steerCalls: string[] = [];
  interruptCalls = 0;
  closeCalls = 0;
  private closed = false;
  constructor(private readonly results: ExecutorResult[]) {}

  async run(
    taskId: Id,
    instruction: string,
    _onEvidence?: (evidence: readonly ExecutorEvidence[]) => void
  ): Promise<ExecutorResult> {
    this.runCalls.push({ taskId, instruction });
    return this.results.shift() ?? { kind: "completed", output: "default", threadId: this.workerThreadId };
  }

  async steer(instruction: string): Promise<void> {
    this.steerCalls.push(instruction);
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
  }

  getThreadAudit(): CodexThreadAudit {
    return {
      worker_session_id: this.workerSessionId,
      source_thread_id: this.sourceThreadId,
      worker_thread_id: this.workerThreadId,
      fork_rpc_count: 1,
      source_thread_read_count: this.closed ? 2 : 1,
      source_thread_resume_count: 0,
      source_thread_turn_start_count: 0,
      worker_thread_turn_start_count: this.runCalls.length,
      worker_thread_steer_count: this.steerCalls.length,
      worker_thread_interrupt_count: this.interruptCalls,
      source_turn_count_before: 1,
      ...(this.closed ? { source_turn_count_after: 1, source_terminal_snapshot_status: "available" as const } : {}),
      worker_session_closed: this.closed
    };
  }
}

function serviceWithWorker(
  worker: CodexThreadWorkerSession,
  factoryCalls: { count: number } = { count: 0 }
): RegisteredWorkspaceTaskService {
  const root = workspaceRoot();
  const registry = new RegisteredWorkspaceRegistry([{ id: "known", root }]);
  return new RegisteredWorkspaceTaskService(
    registry,
    () => {
      throw new Error("legacy executor must not be used");
    },
    async (request: CodexThreadTaskRequest) => {
      factoryCalls.count += 1;
      assert.equal(request.workspace_id, "known");
      assert.equal(request.source_thread_id, "source-1");
      return worker;
    }
  );
}

test("continue reuses the same worker session and accept closes it", async () => {
  const worker = new FakeWorker([
    { kind: "completed", output: "first", threadId: "worker-1" },
    { kind: "completed", output: "second", threadId: "worker-1" }
  ]);
  const factoryCalls = { count: 0 };
  const service = serviceWithWorker(worker, factoryCalls);

  const { taskId } = service.startTaskFromCodexThread({
    workspace_id: "known",
    source_thread_id: "source-1",
    instruction: "first"
  });
  await waitForReady(service, taskId);
  assert.deepEqual(service.taskView(taskId), {
    taskId,
    state: "waiting_for_supervisor_review",
    executor: "codex",
    sourceThreadId: "source-1",
    threadMode: "ephemeral_fork",
    threadId: "worker-1",
    evidence: [],
    threadAudit: {
      worker_session_id: "worker-session-1",
      source_thread_id: "source-1",
      worker_thread_id: "worker-1",
      fork_rpc_count: 1,
      source_thread_read_count: 1,
      source_thread_resume_count: 0,
      source_thread_turn_start_count: 0,
      worker_thread_turn_start_count: 1,
      worker_thread_steer_count: 0,
      worker_thread_interrupt_count: 0,
      source_turn_count_before: 1,
      worker_session_closed: false
    },
    ready: true,
    review_output: "first"
  });

  await service.controlTask(taskId, "continue", "second");
  await waitForReady(service, taskId);
  assert.equal(factoryCalls.count, 1);
  assert.deepEqual(worker.runCalls.map(({ instruction }) => instruction), ["first", "second"]);
  assert.equal(service.taskView(taskId)?.review_output, "second");

  const completed = await service.controlTask(taskId, "accept");
  assert.equal(completed.state, "completed");
  assert.equal(completed.output, "second");
  assert.equal(completed.threadAudit?.worker_thread_turn_start_count, 2);
  assert.equal(completed.threadAudit?.source_turn_count_after, 1);
  assert.equal(completed.threadAudit?.worker_session_closed, true);
  assert.equal(worker.closeCalls, 1);
});

test("failed worker turns close the worker session", async () => {
  const worker = new FakeWorker([{
    kind: "failed",
    error: serializeError(new CoreError("CODEX_PROTOCOL_ERROR")),
    threadId: "worker-1"
  }]);
  const service = serviceWithWorker(worker);

  const { taskId } = service.startTaskFromCodexThread({
    workspace_id: "known",
    source_thread_id: "source-1",
    instruction: "fail"
  });
  await waitForReady(service, taskId);

  const view = service.taskView(taskId);
  assert.equal(view?.state, "failed");
  assert.equal(view?.error?.code, "CODEX_PROTOCOL_ERROR");
  assert.equal(worker.closeCalls, 1);
});

test("steer and interrupt reach the running worker, then interruption closes it", async () => {
  let resolveRun!: (result: ExecutorResult) => void;
  const worker: CodexThreadWorkerSession = {
    sourceThreadId: "source-1",
    workerThreadId: "worker-1",
    workerSessionId: "worker-session-2",
    run: async () => new Promise<ExecutorResult>((resolve) => { resolveRun = resolve; }),
    steer: async (instruction) => { assert.equal(instruction, "focus"); },
    interrupt: async () => {},
    close: async () => {},
    getThreadAudit: () => ({
      worker_session_id: "worker-session-2",
      source_thread_id: "source-1",
      worker_thread_id: "worker-1",
      fork_rpc_count: 1,
      source_thread_read_count: 2,
      source_thread_resume_count: 0,
      source_thread_turn_start_count: 0,
      worker_thread_turn_start_count: 1,
      worker_thread_steer_count: 1,
      worker_thread_interrupt_count: 1,
      source_turn_count_before: 1,
      source_turn_count_after: 1,
      source_terminal_snapshot_status: "available",
      worker_session_closed: true
    })
  };
  let factoryCalls = 0;
  const root = workspaceRoot();
  const service = new RegisteredWorkspaceTaskService(
    new RegisteredWorkspaceRegistry([{ id: "known", root }]),
    () => {
      throw new Error("legacy executor must not be used");
    },
    async () => {
      factoryCalls += 1;
      return worker;
    }
  );

  const { taskId } = service.startTaskFromCodexThread({
    workspace_id: "known",
    source_thread_id: "source-1",
    instruction: "inspect"
  });
  while (service.taskView(taskId)?.state !== "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await service.controlTask(taskId, "steer", "focus");
  await service.controlTask(taskId, "interrupt");
  resolveRun({ kind: "interrupted", output: "partial", threadId: "worker-1" });
  await waitForReady(service, taskId);

  assert.equal(factoryCalls, 1);
  assert.equal(service.taskView(taskId)?.state, "failed");
  assert.equal(service.taskView(taskId)?.partial_output, "partial");
});
