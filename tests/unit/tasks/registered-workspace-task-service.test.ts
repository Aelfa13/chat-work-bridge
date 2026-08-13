import assert from "node:assert/strict";
import test from "node:test";

import type { SerializedError } from "../../../src/core/errors.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "../../../src/executors/executor.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const ROOT = "/registered/root";

function registry(): RegisteredWorkspaceRegistry {
  return new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT }]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForTerminal(service: RegisteredWorkspaceTaskService, taskId: string): Promise<void> {
  while (service.status(taskId)?.state === "queued" || service.status(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("returns immediately and exposes queued/running without a result", async () => {
  const pending = deferred<ExecutorResult>();
  const calls: ExecutorRequest[] = [];
  const executor: Executor = { execute: (request) => { calls.push(request); return pending.promise; } };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });

  assert.deepEqual(service.status(taskId), { taskId, state: "queued" });
  assert.equal(service.result(taskId), undefined);
  await Promise.resolve();
  assert.deepEqual(service.status(taskId), { taskId, state: "running" });
  assert.equal(service.result(taskId), undefined);
  assert.equal(calls[0]?.taskId, taskId);
  pending.resolve({ kind: "completed", output: "done" });
  await waitForTerminal(service, taskId);
});

test("taskView polls a legacy runTask through completed output", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = { execute: () => pending.promise };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });

  assert.deepEqual(service.taskView(taskId), { taskId, state: "queued", ready: false });
  await Promise.resolve();
  assert.deepEqual(service.taskView(taskId), { taskId, state: "running", ready: false });

  pending.resolve({ kind: "completed", output: "proposal diff" });
  await waitForTerminal(service, taskId);

  assert.deepEqual(service.taskView(taskId), {
    taskId,
    state: "completed",
    ready: true,
    output: "proposal diff"
  });
});

test("records completed output and preserves the instruction", async () => {
  const calls: ExecutorRequest[] = [];
  const executor: Executor = {
    execute: async (request) => { calls.push(request); return { kind: "completed", output: "exact output\n\n" }; }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const instruction = "  exact instruction\nwith bytes $()  ";
  const { taskId } = service.runTask({ workspace_id: "known", instruction });

  await waitForTerminal(service, taskId);

  assert.deepEqual(calls, [{ taskId, instruction }]);
  assert.deepEqual(service.status(taskId), { taskId, state: "completed" });
  assert.deepEqual(service.result(taskId), { id: taskId, state: "completed", output: "exact output\n\n" });
});

test("applies a completed-output transform exactly once before storing the result", async () => {
  let transforms = 0;
  const executor: Executor = { execute: async () => ({ kind: "completed", output: "raw" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask(
    { workspace_id: "known", instruction: "inspect" },
    (output) => { transforms += 1; return `${output}-transformed`; }
  );

  await waitForTerminal(service, taskId);

  assert.equal(transforms, 1);
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "completed",
    output: "raw-transformed"
  });
  assert.equal(transforms, 1);
});

test("records executor failures", async () => {
  const error: SerializedError = {
    code: "CODEX_EXECUTION_FAILED",
    message: "Codex execution failed."
  };
  const executor: Executor = { execute: async () => ({ kind: "failed", error }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });

  await waitForTerminal(service, taskId);

  assert.deepEqual(service.status(taskId), { taskId, state: "failed" });
  assert.deepEqual(service.result(taskId), { id: taskId, state: "failed", error });
});

test("records an interrupted legacy task as an execution failure", async () => {
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "partial" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });

  await waitForTerminal(service, taskId);

  assert.deepEqual(service.status(taskId), { taskId, state: "failed" });
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "CODEX_EXECUTION_FAILED",
      message: "Codex execution failed."
    }
  });
});

test("records an interrupted interactive task as an execution failure without review output", async () => {
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "partial" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect" });

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(service.taskView(taskId), {
    taskId,
    state: "failed",
    ready: true,
    evidence: [],
    error: {
      code: "CODEX_EXECUTION_FAILED",
      message: "Codex execution failed."
    }
  });
});

test("interactive execution remains read-only when workspace writes are allowed", async () => {
  const calls: ExecutorRequest[] = [];
  const executor: Executor = {
    execute: async (request) => { calls.push(request); return { kind: "completed", output: "done" }; }
  };
  const writableRegistry = new RegisteredWorkspaceRegistry([
    { id: "known", root: ROOT, allow_write: true }
  ]);
  const service = new RegisteredWorkspaceTaskService(writableRegistry, () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect" });

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sandbox, "read-only");
});

test("records an unknown workspace asynchronously without creating an executor", async () => {
  let factories = 0;
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    factories += 1;
    throw new Error("must not run");
  });
  const { taskId } = service.runTask({ workspace_id: "unknown", instruction: "inspect" });

  assert.deepEqual(service.status(taskId), { taskId, state: "queued" });
  await waitForTerminal(service, taskId);

  assert.equal(factories, 0);
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "UNKNOWN_WORKSPACE",
      message: "The requested workspace is not registered."
    }
  });
});

test("returns undefined for invalid and unknown task ids", () => {
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    throw new Error("must not run");
  });

  for (const taskId of [undefined, null, "invalid", "00000000-0000-4000-8000-000000000000"]) {
    assert.equal(service.status(taskId), undefined);
    assert.equal(service.result(taskId), undefined);
  }
});

test("only exposes supported states", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = { execute: () => pending.promise };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });
  const states = new Set<string>();

  states.add(service.status(taskId)!.state);

  await Promise.resolve();
  states.add(service.status(taskId)!.state);

  pending.resolve({ kind: "completed", output: "done" });
  await waitForTerminal(service, taskId);
  states.add(service.status(taskId)!.state);

  for (const state of states) assert.ok(["queued", "running", "completed", "failed"].includes(state));
});

test("retains only the newest 100 terminal records without evicting live task states", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = {
    execute: async (request) => request.instruction === "hold"
      ? pending.promise
      : { kind: "completed", output: "done" }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const queuedTaskId = "00000000-0000-4000-8000-000000000001";
  (service as unknown as { tasks: Map<string, { state: "queued" }> }).tasks.set(queuedTaskId, { state: "queued" });

  const { taskId: runningTaskId } = service.startTask({ workspace_id: "known", instruction: "hold" });
  while (service.taskView(runningTaskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.taskView(runningTaskId)?.state, "running");

  const { taskId: reviewTaskId } = service.startTask({ workspace_id: "known", instruction: "review" });
  while (["queued", "running"].includes(service.taskView(reviewTaskId)?.state ?? "")) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.taskView(reviewTaskId)?.state, "waiting_for_supervisor_review");

  const legacyTaskIds = Array.from({ length: 101 }, () =>
    service.runTask({ workspace_id: "known", instruction: "legacy" }).taskId
  );
  await Promise.all(legacyTaskIds.map((taskId) => waitForTerminal(service, taskId)));
  assert.equal(service.status(legacyTaskIds[0]!), undefined);
  for (const taskId of legacyTaskIds.slice(1)) assert.equal(service.status(taskId)?.state, "completed");
  assert.equal(service.status(queuedTaskId)?.state, "queued");
  assert.equal(service.taskView(runningTaskId)?.state, "running");
  assert.equal(service.taskView(reviewTaskId)?.state, "waiting_for_supervisor_review");

  const interactiveTaskIds: string[] = [];
  for (let index = 0; index < 101; index += 1) {
    const { taskId } = service.startTask({ workspace_id: "known", instruction: "interactive" });
    while (["queued", "running"].includes(service.taskView(taskId)?.state ?? "")) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await service.controlTask(taskId, "accept");
    interactiveTaskIds.push(taskId);
  }

  assert.equal(service.taskView(interactiveTaskIds[0]!), undefined);
  for (const taskId of interactiveTaskIds.slice(1)) assert.equal(service.taskView(taskId)?.state, "completed");
  assert.equal(service.status(queuedTaskId)?.state, "queued");
  assert.equal(service.taskView(runningTaskId)?.state, "running");
  assert.equal(service.taskView(reviewTaskId)?.state, "waiting_for_supervisor_review");
});
