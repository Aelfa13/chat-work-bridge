import { newId } from "../core/ids.js";
import { serializeError } from "../core/errors.js";
import { assertTransition } from "../core/state-machine.js";
import type { Id } from "../core/ids.js";
import type { SerializedError } from "../core/errors.js";
import type { TaskState } from "../core/types.js";
import type { Executor, ExecutorResult } from "../executors/executor.js";

export type TaskSnapshot =
  | {
    readonly id: Id;
    readonly state: "completed";
    readonly output: string;
  }
  | {
    readonly id: Id;
    readonly state: "failed";
    readonly error: SerializedError;
  };

export class TaskOrchestrator {
  constructor(private readonly executor: Executor) {}

  async execute(instruction: string): Promise<TaskSnapshot> {
    const taskId = newId();
    let state: TaskState = "created";

    assertTransition(state, "inspecting");
    state = "inspecting";

    let result: ExecutorResult;
    try {
      result = await this.executor.execute({ taskId, instruction });
    } catch (error) {
      const safeError = serializeError(error);
      assertTransition(state, "failed");
      state = "failed";
      return { id: taskId, state, error: safeError };
    }

    if (result.kind === "completed") {
      assertTransition(state, "completed");
      state = "completed";
      return { id: taskId, state, output: result.output };
    }

    assertTransition(state, "failed");
    state = "failed";
    return { id: taskId, state, error: result.error };
  }
}
