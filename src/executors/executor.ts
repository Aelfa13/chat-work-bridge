import type { Id } from "../core/ids.js";
import type { SerializedError } from "../core/errors.js";

export interface ExecutorRequest {
  readonly taskId: Id;
  readonly instruction: string;
}

export type ExecutorResult =
  | { readonly kind: "completed"; readonly output: string }
  | {
    readonly kind: "failed";
    readonly error: SerializedError;
  };

export interface Executor {
  execute(request: ExecutorRequest): Promise<ExecutorResult>;
}
