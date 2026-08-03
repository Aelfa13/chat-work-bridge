import assert from "node:assert/strict";
import test from "node:test";

import { CoreError } from "../../src/core/errors.js";
import { assertTransition, canTransition, isTerminalState } from "../../src/core/state-machine.js";
import { TASK_STATES, type TaskState } from "../../src/core/types.js";

const EXPECTED_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  created: ["inspecting", "cancelling", "failed", "interrupted"],
  inspecting: ["completed", "failed", "cancelling", "interrupted"],
  cancelling: ["completed", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: []
};

test("matches the complete task lifecycle transition matrix", () => {
  for (const from of TASK_STATES) {
    for (const to of TASK_STATES) {
      const allowed = EXPECTED_TRANSITIONS[from].includes(to);

      assert.equal(canTransition(from, to), allowed, `${from} -> ${to}`);
      if (allowed) {
        assert.doesNotThrow(() => assertTransition(from, to), `${from} -> ${to}`);
      } else {
        assert.throws(
          () => assertTransition(from, to),
          (error: unknown) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION",
          `${from} -> ${to}`
        );
      }
    }
  }
});

test("recognizes every terminal task state", () => {
  for (const state of ["completed", "failed", "cancelled", "interrupted"] as const) {
    assert.equal(isTerminalState(state), true);
  }
});

test("keeps active task states non-terminal", () => {
  for (const state of ["created", "inspecting", "cancelling"] as const) {
    assert.equal(isTerminalState(state), false);
  }
});
