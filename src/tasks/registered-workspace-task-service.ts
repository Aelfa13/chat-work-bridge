import { isId, newId } from "../core/ids.js";
import { serializeError } from "../core/errors.js";
import type { Id } from "../core/ids.js";
import type { SerializedError } from "../core/errors.js";
import { CoreError } from "../core/errors.js";
import type { Executor, ExecutorEvidence } from "../executors/executor.js";
import { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";

export type ExecutorName = "codex" | "dsh";

export interface RegisteredWorkspaceTaskRequest {
  readonly workspace_id: string;
  readonly instruction: string;
  readonly executor?: ExecutorName;
}

type NormalizedRegisteredWorkspaceTaskRequest = RegisteredWorkspaceTaskRequest & { readonly executor: ExecutorName };

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
    // Present only when the executor returned genuine partial output for an
    // interrupted run; never for ordinary failures and never as completed
    // output. Empty partial output is omitted entirely.
    readonly partial_output?: string | undefined;
  };

export type ExecutorFactory = (executor: ExecutorName, workspaceRoot: string) => Executor;
export type CompletedOutputTransform = (output: string) => string;

export type RegisteredWorkspaceTaskState = "queued" | "running" | "completed" | "failed";

export type ControlledTaskState = RegisteredWorkspaceTaskState | "waiting_for_supervisor_review";
export interface ControlledTaskView {
  readonly taskId: Id;
  readonly state: ControlledTaskState;
  // The executor selection is fixed for the whole task lifetime. It is always
  // reported honestly: a Codex task may additionally expose its real native
  // app-server thread id, while a DSH task never gets a fabricated session or
  // thread id (DSH headless currently has no machine-resumable session seam).
  readonly executor: ExecutorName;
  readonly threadId?: string | undefined;
  readonly ready?: boolean;
  readonly output?: string | undefined;
  readonly review_output?: string | undefined;
  readonly partial_output?: string | undefined;
  readonly evidence?: readonly ExecutorEvidence[];
  readonly error?: SerializedError | undefined;
}

type TaskRecord =
  | { state: "queued" | "running"; executor: ExecutorName }
  | { state: "completed" | "failed"; executor: ExecutorName; result: RegisteredWorkspaceTaskResult };

const MAX_TERMINAL_TASK_HISTORY = 100;

export type TerminalTaskHandler = (result: RegisteredWorkspaceTaskResult) => void | Promise<void>;

function interruptedError(executor: ExecutorName): SerializedError {
  return serializeError(new CoreError(executor === "dsh" ? "DSH_EXECUTION_FAILED" : "CODEX_EXECUTION_FAILED"));
}

// Interrupt keeps the failed terminal state and its existing safe error, and
// additionally retains the executor's genuine partial output. Empty partial
// output (interrupt before anything was produced) is not fabricated: the field
// is simply omitted.
function interruptedTaskResult(taskId: Id, executor: ExecutorName, partialOutput: string): RegisteredWorkspaceTaskResult {
  if (partialOutput === "") {
    return { id: taskId, state: "failed", error: interruptedError(executor) };
  }
  return { id: taskId, state: "failed", error: interruptedError(executor), partial_output: partialOutput };
}

export class RegisteredWorkspaceTaskService {
  private readonly tasks = new Map<Id, TaskRecord>();
  private readonly pinnedTaskIds = new Set<Id>();
  private legacyTerminalTaskIds: Id[] = [];

  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly executorFactory: ExecutorFactory
  ) {}

  runTask(
    request: RegisteredWorkspaceTaskRequest,
    completedOutputTransform?: CompletedOutputTransform,
    terminalTaskHandler?: TerminalTaskHandler
  ): { taskId: Id } {
    const taskId = newId();
    const normalizedRequest = { ...request, executor: request.executor ?? "codex" };
    this.tasks.set(taskId, { state: "queued", executor: normalizedRequest.executor });
    queueMicrotask(() => void this.run(taskId, normalizedRequest, completedOutputTransform, terminalTaskHandler));
    return { taskId };
  }

  pinTask(taskId: Id): void {
    this.pinnedTaskIds.add(taskId);
  }

  unpinTask(taskId: Id): void {
    this.pinnedTaskIds.delete(taskId);
    this.trimLegacyTerminalTasks();
  }

  restoreControlledPatchTask(taskId: Id, output: string, pinned: boolean): void {
    if (this.tasks.has(taskId) || this.interactive.has(taskId)) {
      throw new CoreError("INTERNAL_ERROR");
    }
    const result: RegisteredWorkspaceTaskResult = { id: taskId, state: "completed", output };
    this.tasks.set(taskId, { state: "completed", executor: "codex", result });
    this.legacyTerminalTaskIds.push(taskId);
    if (pinned) this.pinnedTaskIds.add(taskId);
    this.trimLegacyTerminalTasks();
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
    const normalizedRequest = { ...request, executor: request.executor ?? "codex" };
    this.interactive.set(taskId, { state: "queued", request: normalizedRequest, evidence: [] });
    queueMicrotask(() => void this.executeInteractive(taskId));
    return { taskId };
  }

  taskView(taskId: unknown): ControlledTaskView | undefined {
    if (!isId(taskId)) return undefined;
    const record = this.interactive.get(taskId);
    if (!record) {
      const legacy = this.tasks.get(taskId);
      if (!legacy) return undefined;
      if (!("result" in legacy)) {
        return { taskId, state: legacy.state, executor: legacy.executor, ready: false };
      }
      return legacy.result.state === "completed"
        ? { taskId, state: "completed", executor: legacy.executor, ready: true, output: legacy.result.output }
        : {
          taskId,
          state: "failed",
          executor: legacy.executor,
          ready: true,
          error: legacy.result.error,
          ...(legacy.result.partial_output === undefined ? {} : { partial_output: legacy.result.partial_output })
        };
    }
    const base: ControlledTaskView = {
      taskId,
      state: record.state,
      executor: record.request.executor,
      evidence: record.evidence,
      ...(record.threadId === undefined ? {} : { threadId: record.threadId })
    };
    if (record.state === "queued" || record.state === "running") return { ...base, ready: false };
    if (record.state === "waiting_for_supervisor_review") return { ...base, ready: true, review_output: record.output };
    if (record.state === "completed") return { ...base, ready: true, output: record.output };
    return {
      ...base,
      ready: true,
      error: record.error,
      ...(record.partialOutput === undefined || record.partialOutput === ""
        ? {}
        : { partial_output: record.partialOutput })
    };
  }

  async controlTask(taskId: unknown, action: "continue" | "steer" | "interrupt" | "accept", instruction?: string): Promise<ControlledTaskView> {
    if (!isId(taskId)) throw new CoreError("INVALID_STATE_TRANSITION");
    const record = this.interactive.get(taskId);
    if (!record) throw new CoreError("INVALID_STATE_TRANSITION");
    if (action === "accept") {
      if (record.state !== "waiting_for_supervisor_review") throw new CoreError("INVALID_STATE_TRANSITION");
      record.state = "completed";
      this.interactiveTerminalTaskIds.push(taskId);
      this.trimInteractiveTerminalTasks();
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
    state: ControlledTaskState; request: NormalizedRegisteredWorkspaceTaskRequest; evidence: readonly ExecutorEvidence[];
    executor?: Executor | undefined; threadId?: string | undefined; output?: string | undefined;
    partialOutput?: string | undefined; error?: SerializedError | undefined;
  }>();
  private interactiveTerminalTaskIds: Id[] = [];

  private async executeInteractive(taskId: Id): Promise<void> {
    const record = this.interactive.get(taskId);
    if (!record) return;
    record.state = "running";
    try {
      const registration = this.registry.resolveExecution(record.request.workspace_id);
      const executor = this.executorFactory(record.request.executor, registration.root);
      record.executor = executor;
      const result = await executor.execute({ taskId, instruction: record.request.instruction,
        sandbox: "read-only", threadId: record.threadId,
        onEvidence: (items) => { record.evidence = items; } });
      record.executor = undefined;
      record.threadId = result.threadId ?? record.threadId;
      record.evidence = result.evidence ?? record.evidence;
      if (result.kind === "failed") { record.state = "failed"; record.error = result.error; }
      else if (result.kind === "interrupted") {
        // The failed terminal state and its safe error are unchanged; the
        // executor's genuine partial output is retained separately and never
        // treated as completed review output.
        record.partialOutput = result.output;
        record.output = undefined;
        record.state = "failed";
        record.error = interruptedError(record.request.executor);
      } else { record.state = "waiting_for_supervisor_review"; record.output = result.output; }
      if (record.state === "failed") this.recordInteractiveTerminalTask(taskId);
    } catch (error) {
      record.executor = undefined;
      record.state = "failed";
      record.error = serializeError(error);
      this.recordInteractiveTerminalTask(taskId);
    }
  }

  private async run(
    taskId: Id,
    request: NormalizedRegisteredWorkspaceTaskRequest,
    completedOutputTransform?: CompletedOutputTransform,
    terminalTaskHandler?: TerminalTaskHandler
  ): Promise<void> {
    this.tasks.set(taskId, { state: "running", executor: request.executor });
    try {
      const workspaceRoot = this.registry.resolve(request.workspace_id);
      const executor = this.executorFactory(request.executor, workspaceRoot);
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
          : interruptedTaskResult(taskId, request.executor, result.output);
      await this.recordLegacyTerminalTask(taskId, taskResult, terminalTaskHandler);
    } catch (error) {
      const result: RegisteredWorkspaceTaskResult = {
        id: taskId,
        state: "failed",
        error: serializeError(error)
      };
      await this.recordLegacyTerminalTask(taskId, result);
    }
  }

  private async recordLegacyTerminalTask(
    taskId: Id,
    result: RegisteredWorkspaceTaskResult,
    terminalTaskHandler?: TerminalTaskHandler
  ): Promise<void> {
    await terminalTaskHandler?.(result);
    const executor = this.tasks.get(taskId)?.executor ?? "codex";
    this.tasks.set(taskId, { state: result.state, executor, result });
    this.legacyTerminalTaskIds.push(taskId);
    this.trimLegacyTerminalTasks();
  }

  private recordInteractiveTerminalTask(taskId: Id): void {
    this.interactiveTerminalTaskIds.push(taskId);
    this.trimInteractiveTerminalTasks();
  }

  private trimLegacyTerminalTasks(): void {
    const terminalTaskIds = this.legacyTerminalTaskIds.filter((taskId) => {
      const task = this.tasks.get(taskId);
      return task?.state === "completed" || task?.state === "failed";
    });
    const unpinnedTaskIds = terminalTaskIds.filter((taskId) => !this.pinnedTaskIds.has(taskId));
    const evictedTaskIds = new Set(unpinnedTaskIds.slice(
      0,
      Math.max(0, unpinnedTaskIds.length - MAX_TERMINAL_TASK_HISTORY)
    ));
    for (const taskId of evictedTaskIds) this.tasks.delete(taskId);
    this.legacyTerminalTaskIds = terminalTaskIds.filter((taskId) => !evictedTaskIds.has(taskId));
  }

  private trimInteractiveTerminalTasks(): void {
    const terminalTaskIds = this.interactiveTerminalTaskIds.filter((taskId) => {
      const task = this.interactive.get(taskId);
      return task?.state === "completed" || task?.state === "failed";
    });
    const evictedTaskIds = new Set(terminalTaskIds.slice(
      0,
      Math.max(0, terminalTaskIds.length - MAX_TERMINAL_TASK_HISTORY)
    ));
    for (const taskId of evictedTaskIds) this.interactive.delete(taskId);
    this.interactiveTerminalTaskIds = terminalTaskIds.filter((taskId) => !evictedTaskIds.has(taskId));
  }
}
