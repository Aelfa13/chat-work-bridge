import { isId, newId } from "../core/ids.js";
import { serializeError } from "../core/errors.js";
import type { Id } from "../core/ids.js";
import type { SerializedError } from "../core/errors.js";
import { CoreError } from "../core/errors.js";
import type { Executor, ExecutorEvidence } from "../executors/executor.js";
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

export type ControlledTaskState = RegisteredWorkspaceTaskState | "waiting_for_supervisor_review";
export interface ControlledTaskView {
  readonly taskId: Id;
  readonly state: ControlledTaskState;
  readonly ready?: boolean;
  readonly output?: string | undefined;
  readonly review_output?: string | undefined;
  readonly evidence?: readonly ExecutorEvidence[];
  readonly error?: SerializedError | undefined;
}

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

  startTask(request: RegisteredWorkspaceTaskRequest): { taskId: Id } {
    const taskId = newId();
    this.interactive.set(taskId, { state: "queued", request, evidence: [] });
    queueMicrotask(() => void this.executeInteractive(taskId));
    return { taskId };
  }

  taskView(taskId: unknown): ControlledTaskView | undefined {
    if (!isId(taskId)) return undefined;
    const record = this.interactive.get(taskId);
    if (!record) return undefined;
    const base = { taskId, state: record.state, evidence: record.evidence };
    if (record.state === "queued" || record.state === "running") return { ...base, ready: false };
    if (record.state === "waiting_for_supervisor_review") return { ...base, ready: true, review_output: record.output };
    if (record.state === "completed") return { ...base, ready: true, output: record.output };
    return { ...base, ready: true, error: record.error };
  }

  async controlTask(taskId: unknown, action: "continue" | "steer" | "interrupt" | "accept", instruction?: string): Promise<ControlledTaskView> {
    if (!isId(taskId)) throw new CoreError("INVALID_STATE_TRANSITION");
    const record = this.interactive.get(taskId);
    if (!record) throw new CoreError("INVALID_STATE_TRANSITION");
    if (action === "accept") {
      if (record.state !== "waiting_for_supervisor_review") throw new CoreError("INVALID_STATE_TRANSITION");
      record.state = "completed";
    } else if (action === "continue") {
      if (record.state !== "waiting_for_supervisor_review" || !instruction?.trim()) throw new CoreError("INVALID_STATE_TRANSITION");
      record.request = { ...record.request, instruction };
      record.state = "queued";
      queueMicrotask(() => void this.executeInteractive(taskId));
    } else if (action === "steer") {
      if (record.state !== "running" || !instruction?.trim() || !record.executor?.steer) throw new CoreError("INVALID_STATE_TRANSITION");
      await record.executor.steer(instruction);
    } else {
      if (record.state !== "running" || !record.executor?.interrupt) throw new CoreError("INVALID_STATE_TRANSITION");
      await record.executor.interrupt();
    }
    return this.taskView(taskId)!;
  }

  private readonly interactive = new Map<Id, {
    state: ControlledTaskState; request: RegisteredWorkspaceTaskRequest; evidence: readonly ExecutorEvidence[];
    executor?: Executor | undefined; threadId?: string | undefined; output?: string | undefined; error?: SerializedError | undefined;
  }>();

  private async executeInteractive(taskId: Id): Promise<void> {
    const record = this.interactive.get(taskId);
    if (!record) return;
    record.state = "running";
    try {
      const registration = this.registry.resolveExecution(record.request.workspace_id);
      const executor = this.executorFactory(registration.root);
      record.executor = executor;
      const result = await executor.execute({ taskId, instruction: record.request.instruction,
        sandbox: "read-only", threadId: record.threadId,
        onEvidence: (items) => { record.evidence = items; } });
      record.executor = undefined;
      record.threadId = result.threadId ?? record.threadId;
      record.evidence = result.evidence ?? record.evidence;
      if (result.kind === "failed") { record.state = "failed"; record.error = result.error; }
      else if (result.kind === "interrupted") {
        record.state = "failed";
        record.output = undefined;
        record.error = serializeError(new CoreError("CODEX_EXECUTION_FAILED"));
      } else { record.state = "waiting_for_supervisor_review"; record.output = result.output; }
    } catch (error) {
      record.executor = undefined; record.state = "failed"; record.error = serializeError(error);
    }
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
        : result.kind === "failed"
          ? { id: taskId, state: "failed", error: result.error }
          : { id: taskId, state: "failed", error: serializeError(new CoreError("CODEX_EXECUTION_FAILED")) };
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
