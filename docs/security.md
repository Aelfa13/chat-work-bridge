# Security design

This document separates enforced behavior from operating assumptions for the Engineering Bridge V1 / 1.0.0 candidate. It does not claim a tag, release, or publication, and it does not claim alpha.4 project binding is implemented.

## Enforced in code

- MCP callers select only workspace IDs loaded from trusted startup configuration.
- `run_task`, continued turns, steering, and controlled-patch generation use Codex read-only execution. Codex app-server is started without a shell through `codex app-server --stdio`, with approval `never` and network access disabled.
- Supervisor actions are state checked: `continue` and `accept` require `waiting_for_supervisor_review`; `steer` and `interrupt` require `running`; instructions for `continue` and `steer` must be non-empty. Interrupt completion ends the task as `failed`.
- Write access defaults to disabled and must be enabled per workspace for controlled patches.
- Controlled patch generation requires a clean Git top-level and records HEAD. Files are not modified during generation.
- Application requires exact, case-sensitive `APPLY`, a completed one-use proposal, and rechecks the canonical Git root, HEAD, and clean tracked worktree/index before validating the patch.
- Patch validation accepts modifications to existing tracked regular files and exact 100644 ordinary text-file additions whose target is absent from base HEAD, the index, and the worktree.
- Deletions, rename/copy, binary patches, mode changes, executable additions, symlinks, submodules, unsafe paths, duplicate paths, and malformed or inconsistent headers are rejected.
- Bridge invokes only fixed `git apply --check` and `git apply` operations for application. It never automatically tests, stages, commits, or pushes.
- Returned executor failures use fixed safe messages rather than forwarding stderr.

## Git and operator preconditions

The trusted operator controls the configuration file and must register appropriate local roots. Controlled writes require an existing commit and a clean tracked worktree and index. Other untracked files do not by themselves fail that check, but a proposed new target must be absent from the worktree and index. On filesystems with path aliases, canonical real paths are compared so aliases to the same directory are accepted without treating a genuine subdirectory or different directory as the Git top-level.

The human reviewer must inspect every path and hunk in a proposal before supplying exact `APPLY`. A filename mentioned in a natural-language request is not a semantic file allowlist enforced by the code. Supervisor `accept` accepts read-only task output; it is distinct from `apply_controlled_patch` and does not write files.

## Executor, state, and prompt boundaries

Codex's read-only sandbox is the write boundary during tasks and proposal generation. It is not an OS-level read jail: Codex running as the same user may read other files allowed by the operating system.

Task results can include `review_output` and bounded command/file-change `evidence`. These records, app-server thread IDs, task states, and controlled-patch proposals are process-local and disappear on restart. They are review and diagnostic material, not a durable audit log or an additional write authorization mechanism.

The patch-generation prompt constrains expected output but is not relied upon by itself; code validates the returned patch before application.

## Not provided

Bridge has no caller authentication, HTTP or remote service, UI, persistent database, persistent tasks, persistent proposals, persistent logs, automatic timeout, automatic acceptance, or restart recovery. It does not implement alpha.4 project binding. Do not expose the STDIO process through an untrusted wrapper. Do not place credentials or sensitive material in prompts, configuration, or public reports.

See [SECURITY.md](../SECURITY.md) for the operator-facing security policy and [threat-model.md](threat-model.md) for the compact threat summary.
