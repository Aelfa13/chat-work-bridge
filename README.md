# Engineering Bridge

> Repository skeleton only. No private prototype code has been migrated, and this repository is not ready for use or publication.

Engineering Bridge is planned as a small, local-first bridge that lets an MCP client submit a **read-only** task to Codex inside a pre-registered local Git workspace, then retrieve task status and results.

[简体中文](README.zh-CN.md)

## v0.1 scope

- Codex is the only executor.
- Registered Git workspaces only.
- Target workspaces are read-only.
- The service binds to loopback only.
- No arbitrary shell, argv, executable path, or remote permission escalation.
- Task metadata is stored outside target workspaces.
- Remote transport is out of scope and must be provided separately.

## Explicitly out of scope

- Generic shell execution
- Target-workspace writes
- Multi-executor routing
- Subagents
- Quota-aware routing
- Tray UI or dashboard
- Accounts, teams, or cloud task management
- Private transport, credential-store, or machine-specific integrations

## Repository status

This skeleton intentionally contains no implementation. The package is marked `private` and `UNLICENSED` to prevent accidental publication before the security, dependency-license, and provenance reviews are complete.

See `docs/decisions/0001-v0.1-scope.md` for the frozen first-release boundary.
