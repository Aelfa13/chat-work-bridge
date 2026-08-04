import { isId, newId } from "../core/ids.js";
import { serializeError } from "../core/errors.js";
import type { Id } from "../core/ids.js";
import type { SerializedError } from "../core/errors.js";
import type { Executor } from "../executors/executor.js";
import { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";

export interface RegisteredWorkspaceTaskRequest {
  readonly workspace_id: string;
  readonly instruction: string;
}

export type RegisteredWorkspaceTaskResult =
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

export type ExecutorFactory = (workspaceRoot: string) => Executor;
export type CompletedOutputTransform = (output: string) => string;

export type RegisteredWorkspaceTaskState = "queued" | "running" | "completed" | "failed";

type TaskRecord =
  | { state: "queued" | "running" }
  | { state: "completed" | "failed"; result: RegisteredWorkspaceTaskResult };

export class RegisteredWorkspaceTaskService {
  private readonly tasks = new Map<Id, TaskRecord>();

  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly executorFactory: ExecutorFactory
  ) {}

  runTask(
    request: RegisteredWorkspaceTaskRequest,
    completedOutputTransform?: CompletedOutputTransform
  ): { taskId: Id } {
    const taskId = newId();
    this.tasks.set(taskId, { state: "queued" });
    queueMicrotask(() => void this.run(taskId, request, completedOutputTransform));
    return { taskId };
  }

  status(taskId: unknown): { taskId: Id; state: RegisteredWorkspaceTaskState } | undefined {
    if (!isId(taskId)) return undefined;
    const task = this.tasks.get(taskId);
    return task && { taskId, state: task.state };
  }

  result(taskId: unknown): RegisteredWorkspaceTaskResult | undefined {
    if (!isId(taskId)) return undefined;
    const task = this.tasks.get(taskId);
    return task?.state === "completed" || task?.state === "failed" ? task.result : undefined;
  }

  private async run(
    taskId: Id,
    request: RegisteredWorkspaceTaskRequest,
    completedOutputTransform?: CompletedOutputTransform
  ): Promise<void> {
    this.tasks.set(taskId, { state: "running" });
    try {
      const workspaceRoot = this.registry.resolve(request.workspace_id);
      const executor = this.executorFactory(workspaceRoot);
      const result = await executor.execute({ taskId, instruction: request.instruction });
      const taskResult: RegisteredWorkspaceTaskResult = result.kind === "completed"
        ? {
          id: taskId,
          state: "completed",
          output: completedOutputTransform === undefined
            ? result.output
            : completedOutputTransform(result.output)
        }
        : { id: taskId, state: "failed", error: result.error };
      this.tasks.set(taskId, { state: taskResult.state, result: taskResult });
    } catch (error) {
      const result: RegisteredWorkspaceTaskResult = {
        id: taskId,
        state: "failed",
        error: serializeError(error)
      };
      this.tasks.set(taskId, { state: "failed", result });
    }
  }
}
