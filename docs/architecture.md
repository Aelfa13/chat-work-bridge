# Architecture

Draft placeholder. The v0.1 design will separate:

1. MCP transport and tool schemas
2. Task orchestration and state transitions
3. Registered-workspace boundary enforcement
4. Codex process execution and JSONL parsing
5. Redacted task metadata storage outside target workspaces

The bridge will not reimplement Codex as an agent and will not expose a general command runner.
