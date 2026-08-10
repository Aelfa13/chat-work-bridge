# Security Policy

Engineering Bridge V1 / 1.0.0 candidate connects an MCP client to a local Codex CLI. It remains Alpha software. Treat both the MCP client and the workspace configuration as trusted local inputs, and do not expose the process as a remote service.

## Current enforced controls

- The server uses local STDIO and exposes exactly five tools: `run_task`, `task_result`, `control_task`, `generate_controlled_patch`, and `apply_controlled_patch`.
- Ordinary `run_task` execution is always read-only. Successful interactive turns enter `waiting_for_supervisor_review`; `task_result` exposes state/readiness, bounded evidence, and pre-acceptance `review_output`, then final `output` or `error` after finalization. `control_task` accepts only interactive `run_task` task IDs and state-checks `continue`, `steer`, `interrupt`, and `accept`. Continue preserves native Codex thread continuity; interrupt applies only to running interactive tasks and ends them as failed.
- Workspace IDs and roots come from a startup configuration file. Roots must be absolute and normalized, duplicate IDs are rejected, and MCP callers cannot add or replace registrations.
- Codex runs through `codex app-server --stdio` with approval `never`, a read-only sandbox, network disabled, and the configured workspace as its working directory.
- Instructions use the app-server STDIO protocol. The bridge does not invoke a shell or accept caller-supplied executable paths or process arguments.
- The Codex child receives a small allowlist of inherited environment fields.
- Returned execution failures use fixed error codes and messages rather than forwarding Codex stderr or raw internal errors.
- Tasks and results are held only in process memory.
- Workspace writes default to disabled. Patch generation uses the legacy proposal-task path and requires an explicitly enabled workspace whose canonical real path equals its Git top-level, a clean tracked worktree/index, and a recorded HEAD. It remains read-only. Poll its patch task ID through `task_result` until `state=completed`, when the diff is returned as `output`; it never enters supervisor review, exposes `review_output`, or accepts `control_task` actions.
- After human review outside task state, application requires the completed proposal task and exact `APPLY` confirmation, then rechecks root, HEAD, and clean tracked worktree/index state. It permits modifications to existing tracked regular files and additions of absent ordinary text files only with exact mode 100644 and matching `/dev/null` headers. It rejects deletions, binary patches, mode changes, executable additions, symlinks, submodules, rename/copy, unsafe paths, duplicate paths, and new targets present in HEAD, the index, or the worktree. Fixed no-shell `git apply --check` and `git apply` calls receive the patch on standard input; application is once only and never runs tests, stages, commits, or pushes.

## Current limitations

The bridge does not authenticate MCP callers. It has no HTTP or remote transport, persistent storage, persistent logging/redaction system, restart recovery, or automatic timeout. Explicit interruption exists only for running interactive tasks. Alpha.4 project binding is not implemented, so `workspace_id` remains required. Read-only tasks do not verify that configured paths are Git repositories. The bridge does not resolve configured roots with `realpath` or enforce symlink containment. A trusted local operator must therefore control the configuration file, choose workspace roots carefully, and control which local MCP client can start and use the server.

Codex's read-only sandbox prevents writes, but Engineering Bridge does not provide filesystem read isolation. Codex running as the same operating-system user may still read files outside the configured workspace that the user already has permission to read, so use it only on trusted machines and with trusted local clients.

The read-only sandbox is an execution control, not a guarantee that prompts or returned text contain no sensitive data. Do not place credentials or secrets in instructions, configuration, or public bug reports.

## Reporting a vulnerability

Do not publish secrets, credentials, private prompts, source code, or personal data in an issue. After the repository is hosted and its security-advisory feature is available, use that feature for private vulnerability reports. Until then, omit sensitive details from public reports.
