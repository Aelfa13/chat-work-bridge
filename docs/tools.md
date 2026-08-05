# MCP tool reference

Engineering Bridge v0.2.0-alpha.3 exposes exactly four local STDIO MCP tools.

## `run_task`

Inputs: `workspace_id`, `instruction`. Starts a read-only Codex task and returns `task_id`. An unknown workspace becomes a failed task; it does not grant access to a new path.

## `task_result`

Input: `task_id`. This is the single polling tool. It returns the task state and `ready: false` while queued or running, completed output after success, or a safe `{code,message}` error after failure. An unknown task ID returns `UNKNOWN_TASK`.

## `generate_controlled_patch`

Inputs: `workspace_id`, `change_request`. Requires a write-enabled Git top-level with a clean tracked worktree and index. Records and returns `base_head`, starts a read-only proposal task, and does not modify files. Poll it through `task_result` and review the returned unified diff.

## `apply_controlled_patch`

Inputs: `patch_task_id`, `confirmation`. Confirmation must equal `APPLY` exactly. Rechecks repository and patch preconditions, then applies a valid reviewed patch once. It can modify existing tracked regular text files or add an absent ordinary text file from an exact 100644 text diff. A new target must be absent from base HEAD, the current index, and the worktree. It never tests, stages, commits, or pushes.

Tasks and proposals are process-local and are lost when the server stops.
