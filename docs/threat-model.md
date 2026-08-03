# Threat Model

Draft placeholder.

Initial threats to cover:

- A remote caller attempts to register or escape into an unapproved path.
- A symlink or path traversal crosses the workspace root.
- Caller-controlled text becomes a shell argument or command.
- Executor output leaks credentials, source code, or private prompts.
- Cancellation or timeout leaves a child process running.
- Restart corrupts task state or falsely reports recovery.
- A loopback service is exposed through an unsafe transport.
