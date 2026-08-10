# MCP tool reference

This is the tool surface for the Engineering Bridge V1 / 1.0.0 candidate. It does not assert a tag, release, or publication. The local STDIO MCP server exposes exactly five tools.

## `run_task`

Inputs: `workspace_id`, `instruction`.

Starts a supervised Codex task and returns `task_id`. `run_task` is always read-only: it uses approval `never`, a read-only sandbox policy, and disabled network access. An unknown workspace becomes a failed task; it does not grant access to a new path.

## `task_result`

Input: `task_id`.

Returns the task state, readiness, and current bounded `evidence`. Queued and running tasks have `ready: false`. A successful turn has state `waiting_for_supervisor_review`, `ready: true`, and `review_output`. After acceptance, state is `completed` and the reviewed text is returned as `output`. Failures return a safe `{code,message}` error. An unknown task ID returns `UNKNOWN_TASK`.

## `control_task`

Inputs: `task_id`, `action`, and optional `instruction`.

The actions are state-specific:

- `continue`: while `waiting_for_supervisor_review`, requires a non-empty instruction, queues another read-only turn, and preserves app-server thread continuity with `thread/resume`.
- `steer`: while `running`, requires a non-empty instruction and steers the active turn.
- `interrupt`: while `running`, interrupts the active turn. When interruption completes, the task ends as `failed`.
- `accept`: while `waiting_for_supervisor_review`, marks the reviewed output `completed` without starting another turn.

Invalid actions for the current state return `INVALID_STATE_TRANSITION`. There is no automatic timeout, automatic acceptance, persistence, or restart recovery.

## `generate_controlled_patch`

Inputs: `workspace_id`, `change_request`.

Requires a write-enabled Git top-level with a clean tracked worktree and index. It records and returns `base_head`, starts a separate read-only proposal task, and does not modify files. The proposal metadata and task result exist only in the current server process.

## `apply_controlled_patch`

Inputs: `patch_task_id`, `confirmation`.

Confirmation must equal `APPLY` exactly. The proposal must be known, completed, and not already applied. The tool rechecks the canonical Git root, clean tracked state and index, and exact base HEAD before validating and applying the patch once. It can modify existing tracked regular text files or add an absent ordinary text file from an exact 100644 text diff. A new target must be absent from base HEAD, the current index, and the worktree. It never tests, stages, commits, or pushes.

The five-tool surface does not implement alpha.4 project binding.
