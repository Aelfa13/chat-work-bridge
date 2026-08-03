export const TASK_STATES = [
  "created",
  "inspecting",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
] as const;

export type TaskState = (typeof TASK_STATES)[number];
