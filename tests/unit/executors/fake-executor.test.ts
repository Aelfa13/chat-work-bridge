import assert from "node:assert/strict";
import test from "node:test";

import { isId } from "../../../src/core/ids.js";
import type { ExecutorRequest, ExecutorResult } from "../../../src/executors/executor.js";
import { FakeExecutor } from "../../../src/executors/fake-executor.js";

function request(taskId: string, instruction: string): ExecutorRequest {
  if (!isId(taskId)) {
    throw new Error("Test task ID must be a UUID v4.");
  }

  return { taskId, instruction };
}

test("returns the configured completed result", async () => {
  const result: ExecutorResult = { kind: "completed", output: "done" };
  const executor = new FakeExecutor(result);

  assert.equal(await executor.execute(request("550e8400-e29b-41d4-a716-446655440000", "inspect")), result);
});

test("returns the configured failed result", async () => {
  const result: ExecutorResult = {
    kind: "failed",
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
      retryable: false
    }
  };
  const executor = new FakeExecutor(result);

  assert.equal(await executor.execute(request("550e8400-e29b-41d4-a716-446655440001", "inspect")), result);
});

test("records requests in call order", async () => {
  const executor = new FakeExecutor({ kind: "completed", output: "done" });
  const first = request("550e8400-e29b-41d4-a716-446655440002", "first instruction");
  const second = request("550e8400-e29b-41d4-a716-446655440003", "second instruction");

  await executor.execute(first);
  await executor.execute(second);

  assert.deepEqual(executor.calls, [first, second]);
});

test("returns a copy of the recorded calls", async () => {
  const executor = new FakeExecutor({ kind: "completed", output: "done" });
  const first = request("550e8400-e29b-41d4-a716-446655440004", "inspect");

  await executor.execute(first);
  const calls = executor.calls;
  calls.length = 0;

  assert.deepEqual(executor.calls, [first]);
});
