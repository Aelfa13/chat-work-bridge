import assert from "node:assert/strict";
import test from "node:test";

import type { SerializedError } from "../../../src/core/errors.js";
import type { Executor, ExecutorRequest } from "../../../src/executors/executor.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const ROOT = "/registered/root";

function registry(): RegisteredWorkspaceRegistry {
  return new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT }]);
}

test("does not create an executor for an unknown workspace", async () => {
  let factories = 0;
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    factories += 1;
    throw new Error("must not run");
  });

  const result = await service.execute({ workspace_id: "unknown", instruction: "inspect" });

  assert.equal(factories, 0);
  assert.equal(result.state, "failed");
  if (result.state === "failed") {
    assert.deepEqual(result.error, {
      code: "UNKNOWN_WORKSPACE",
      message: "The requested workspace is not registered.",
      retryable: false
    });
  }
});

test("preserves the instruction and uses the result task id", async () => {
  const calls: ExecutorRequest[] = [];
  const roots: string[] = [];
  const executor: Executor = {
    execute: async (request) => {
      calls.push(request);
      return { kind: "completed", output: "done" };
    }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), (root) => {
    roots.push(root);
    return executor;
  });
  const instruction = "  exact instruction\nwith bytes $()  ";

  const result = await service.execute({ workspace_id: "known", instruction });

  assert.equal(calls.length, 1);
  assert.deepEqual(roots, [ROOT]);
  assert.deepEqual(calls, [{ taskId: result.id, instruction }]);
});

test("passes through completed output", async () => {
  const output = "exact output";
  const executor: Executor = {
    execute: async () => ({ kind: "completed", output })
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const result = await service.execute({ workspace_id: "known", instruction: "inspect" });

  assert.equal(result.state, "completed");
  if (result.state === "completed") assert.equal(result.output, output);
});

test("passes through failed error", async () => {
  const error: SerializedError = {
    code: "CODEX_EXECUTION_FAILED",
    message: "Codex execution failed.",
    retryable: false
  };
  const executor: Executor = {
    execute: async () => ({ kind: "failed", error })
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const result = await service.execute({ workspace_id: "known", instruction: "inspect" });

  assert.equal(result.state, "failed");
  if (result.state === "failed") assert.equal(result.error, error);
});
