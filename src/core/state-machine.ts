import { CoreError } from "./errors.js";
import type { TaskState } from "./types.js";

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  created: ["inspecting", "cancelling", "failed", "interrupted"],
  inspecting: ["completed", "failed", "cancelling", "interrupted"],
  cancelling: ["completed", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: []
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new CoreError("INVALID_STATE_TRANSITION");
  }
}

export function isTerminalState(state: TaskState): boolean {
  return TRANSITIONS[state].length === 0;
}
