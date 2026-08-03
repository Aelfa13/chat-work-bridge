# Security Policy

Engineering Bridge is security-sensitive because it connects an MCP client to a local executor.

The project is not yet released. Do not deploy this repository or expose it beyond loopback.

After publication, security reports should use the repository's private vulnerability-reporting channel. Do not include credentials, private prompts, source code, or personal data in a public issue.

## Non-negotiable boundaries for v0.1

- No arbitrary shell or caller-supplied argv.
- No caller-controlled workspace registration.
- No write access to target workspaces.
- Canonical path and symlink-escape validation.
- Minimal child-process environment.
- Redaction before persistent logging.
- Loopback-only service exposure.
