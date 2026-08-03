import { newId } from "../core/ids.js";
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

export class RegisteredWorkspaceTaskService {
  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly executorFactory: ExecutorFactory
  ) {}

  async execute(request: RegisteredWorkspaceTaskRequest): Promise<RegisteredWorkspaceTaskResult> {
    const id: Id = newId();
    try {
      const workspaceRoot = this.registry.resolve(request.workspace_id);
      const executor = this.executorFactory(workspaceRoot);
      const result = await executor.execute({ taskId: id, instruction: request.instruction });
      return result.kind === "completed"
        ? { id, state: "completed", output: result.output }
        : { id, state: "failed", error: result.error };
    } catch (error) {
      return { id, state: "failed", error: serializeError(error) };
    }
  }
}
