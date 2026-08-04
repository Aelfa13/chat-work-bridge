# Security Policy

Engineering Bridge 0.2.0-alpha connects an MCP client to a local Codex CLI. Treat both the MCP client and the workspace configuration as trusted local inputs, and do not expose the process as a remote service.

## Current enforced controls

- The server uses local STDIO and exposes exactly five tools: `run_task`, `task_status`, `task_result`, `generate_controlled_patch`, and `apply_controlled_patch`.
- Workspace IDs and roots come from a startup configuration file. Roots must be absolute and normalized, duplicate IDs are rejected, and MCP callers cannot add or replace registrations.
- Codex is launched with fixed arguments: approval `never`, a read-only sandbox, an ephemeral session, network disabled, and the configured workspace as its working directory.
- Instructions are written to Codex through standard input. The bridge does not invoke a shell or accept caller-supplied executable paths or process arguments.
- The Codex child receives a small allowlist of inherited environment fields.
- Returned execution failures use fixed error codes and messages rather than forwarding Codex stderr or raw internal errors.
- Tasks and results are held only in process memory.
- Workspace writes default to disabled. Patch generation requires an explicitly enabled workspace whose root equals its Git top-level, a clean tracked worktree/index, and a recorded HEAD. Codex remains read-only.
- Application requires the completed proposal task and exact `APPLY` confirmation, then rechecks root, HEAD, and cleanliness. It rejects non-unified, binary, mode, symlink, rename/copy, add/delete, unsafe-path, and non-tracked-regular-file changes. Fixed no-shell `git apply --check` and `git apply` calls receive the patch on standard input; application is once only and never runs tests, stages, commits, or pushes.

## Current limitations

The bridge does not authenticate MCP callers. It has no HTTP or remote transport, persistent storage, persistent logging/redaction system, cancellation, or timeout. Read-only tasks do not verify that configured paths are Git repositories. The bridge does not resolve configured roots with `realpath` or enforce symlink containment. A trusted local operator must therefore control the configuration file, choose workspace roots carefully, and control which local MCP client can start and use the server.

Codex's read-only sandbox prevents writes, but Engineering Bridge does not provide filesystem read isolation. Codex running as the same operating-system user may still read files outside the configured workspace that the user already has permission to read, so use it only on trusted machines and with trusted local clients.

The read-only sandbox is an execution control, not a guarantee that prompts or returned text contain no sensitive data. Do not place credentials or secrets in instructions, configuration, or public bug reports.

## Reporting a vulnerability

Do not publish secrets, credentials, private prompts, source code, or personal data in an issue. After the repository is hosted and its security-advisory feature is available, use that feature for private vulnerability reports. Until then, omit sensitive details from public reports.
