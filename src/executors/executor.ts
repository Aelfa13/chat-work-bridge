import type { Id } from "../core/ids.js";
import type { SerializedError } from "../core/errors.js";

export type SandboxMode = "read-only" | "workspace-write";

export interface EvidenceChange { readonly path: string; readonly diff: string }
export interface ExecutorEvidence {
  readonly id: string;
  readonly type: "commandExecution" | "fileChange";
  readonly status: string;
  readonly command?: string;
  readonly changes?: readonly EvidenceChange[];
}

export interface ExecutorRequest {
  readonly taskId: Id;
  readonly instruction: string;
  readonly sandbox?: SandboxMode;
  readonly threadId?: string | undefined;
  readonly onEvidence?: (evidence: readonly ExecutorEvidence[]) => void;
}

export type ExecutorResult =
  | { readonly kind: "completed" | "interrupted"; readonly output: string; readonly threadId?: string | undefined; readonly evidence?: readonly ExecutorEvidence[] }
  | { readonly kind: "failed"; readonly error: SerializedError; readonly threadId?: string | undefined; readonly evidence?: readonly ExecutorEvidence[] };

export interface Executor {
  execute(request: ExecutorRequest): Promise<ExecutorResult>;
  steer?(instruction: string): Promise<void>;
  interrupt?(): Promise<void>;
}
