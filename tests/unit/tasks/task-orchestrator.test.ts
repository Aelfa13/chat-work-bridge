import assert from "node:assert/strict";
import test from "node:test";

import { isId } from "../../../src/core/ids.js";
import type { SerializedError } from "../../../src/core/errors.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "../../../src/executors/executor.js";
import { FakeExecutor } from "../../../src/executors/fake-executor.js";
import { TaskOrchestrator } from "../../../src/tasks/task-orchestrator.js";

const PRIVATE_MARKERS = ["secret-message", "secret-stack", "secret-cause", "/test-only/private-path"] as const;

class RejectingExecutor implements Executor {
  readonly calls: ExecutorRequest[] = [];

  execute(request: ExecutorRequest): Promise<ExecutorResult> {
    this.calls.push(request);
    return Promise.reject(Object.assign(new Error(PRIVATE_MARKERS[0]), {
      stack: PRIVATE_MARKERS[1],
      cause: new Error(PRIVATE_MARKERS[2]),
      path: PRIVATE_MARKERS[3]
    }));
  }
}

test("returns a completed snapshot and preserves the instruction", async () => {
  const executor = new FakeExecutor({ kind: "completed", output: "inspection result" });
  const orchestrator = new TaskOrchestrator(executor);
  const instruction = "  inspect exactly this  ";

  const snapshot = await orchestrator.execute(instruction);

  assert.equal(snapshot.state, "completed");
  if (snapshot.state === "completed") {
    assert.equal(snapshot.output, "inspection result");
  }
  assert.equal(isId(snapshot.id), true);
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls, [{ taskId: snapshot.id, instruction }]);
});

test("returns the configured failed result", async () => {
  const error: SerializedError = {
    code: "INVALID_STATE_TRANSITION",
    message: "The requested state transition is not allowed.",
    retryable: false
  };
  const executor = new FakeExecutor({ kind: "failed", error });
  const orchestrator = new TaskOrchestrator(executor);

  const snapshot = await orchestrator.execute("inspect");

  assert.equal(snapshot.state, "failed");
  if (snapshot.state === "failed") {
    assert.equal(snapshot.error, error);
  } else {
    assert.fail("Expected a failed snapshot.");
  }
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls, [{ taskId: snapshot.id, instruction: "inspect" }]);
});

test("serializes a rejected executor result without leaking details", async () => {
  const executor = new RejectingExecutor();
  const orchestrator = new TaskOrchestrator(executor);
  const instruction = "  reject exactly this  ";

  const snapshot = await orchestrator.execute(instruction);

  assert.equal(snapshot.state, "failed");
  if (snapshot.state === "failed") {
    assert.deepEqual(snapshot.error, {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
      retryable: false
    });
    const json = JSON.stringify(snapshot);
    for (const marker of PRIVATE_MARKERS) {
      assert.equal(json.includes(marker), false);
    }
  } else {
    assert.fail("Expected a failed snapshot.");
  }
  assert.equal(isId(snapshot.id), true);
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(executor.calls, [{ taskId: snapshot.id, instruction }]);
});
