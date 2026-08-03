import { newId } from "../core/ids.js";
import { serializeError } from "../core/errors.js";
import type { Id } from "../core/ids.js";
import type { Executor } from "../executors/executor.js";
import type { TrustedWorkspace } from "../workspaces/registered-workspace-registry.js";
import { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";
import { TaskOrchestrator } from "./task-orchestrator.js";
import type { TaskSnapshot } from "./task-orchestrator.js";

export interface RegisteredWorkspaceTaskRequest {
  readonly workspace_id: string;
  readonly instruction: string;
}

export type ExecutorFactory = (workspace: TrustedWorkspace) => Executor;

export class RegisteredWorkspaceTaskService {
  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly executorFactory: ExecutorFactory
  ) {}

  async execute(request: RegisteredWorkspaceTaskRequest): Promise<TaskSnapshot> {
    const id: Id = newId();
    try {
      const workspace = await this.registry.resolve(request.workspace_id);
      return await new TaskOrchestrator(this.executorFactory(workspace), id).execute(request.instruction);
    } catch (error) {
      return { id, state: "failed", error: serializeError(error) };
    }
  }
}
