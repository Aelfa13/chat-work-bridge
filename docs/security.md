# Security design

This document separates enforced behavior from operating assumptions for Engineering Bridge v0.2.0-alpha.2.

## Enforced in code

- MCP callers select only workspace IDs loaded from trusted startup configuration.
- Write access defaults to disabled and must be enabled per workspace.
- Codex is started without a shell, with fixed read-only, no-approval, ephemeral, and network-disabled arguments; the instruction is sent on standard input.
- Controlled patch generation requires a clean Git top-level and records HEAD. Files are not modified during generation.
- Application requires exact `APPLY`, rechecks canonical Git root, HEAD and clean tracked state, validates the patch, and accepts only existing tracked regular text files.
- Add/delete, rename/copy, binary, mode, symlink and unsafe-path patches are rejected.
- Bridge invokes only fixed `git apply --check` and `git apply` operations for application. It never automatically tests, stages, commits, or pushes.
- Returned executor failures use fixed safe messages rather than forwarding stderr.

## Git and operator preconditions

The trusted operator controls the configuration file and must register appropriate local roots. Controlled writes require an existing commit and clean tracked state. On filesystems with path aliases, canonical real paths are compared so aliases to the same directory are accepted without treating a genuine subdirectory or different directory as the Git top-level.

The human reviewer must inspect every path and hunk in a proposal. A filename mentioned in a natural-language request is not a semantic file allowlist enforced by the code.

## Executor and prompt boundaries

Codex's read-only sandbox is the write boundary during analysis and proposal generation. It is not an OS-level read jail: Codex running as the same user may read other files allowed by the operating system. The patch-generation prompt constrains expected output but is not relied upon by itself; code validates the returned patch before application.

## Not provided

Bridge has no caller authentication, HTTP or remote service, UI, persistent database, persistent tasks, persistent proposals, persistent logs, cancellation, timeout, or restart recovery. Do not expose the STDIO process through an untrusted wrapper. Do not place credentials or sensitive material in prompts, configuration, or public reports.

See [SECURITY.md](../SECURITY.md) for the operator-facing security policy and [threat-model.md](threat-model.md) for the compact threat summary.
