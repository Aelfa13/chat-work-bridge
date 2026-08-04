# Release notes

## v0.2.0-alpha.1 release candidate

Engineering Bridge v0.2.0-alpha.1 adds opt-in controlled writes while keeping every workspace read-only by default. A write-enabled clean Git workspace can generate a patch proposal without changing files; application requires human review and confirmation exactly equal to `APPLY`. Bridge rechecks repository state and patch targets before applying, and never automatically tests, stages, commits, or pushes.

This release candidate also compares canonical real paths during controlled-write Git-root validation, so macOS aliases such as `/tmp` and `/private/tmp` no longer cause the same directory to be rejected. The English and Chinese READMEs now explain client compatibility, component roles, a generic STDIO MCP configuration, a reproducible first read-only run, and the complete controlled-write flow. The architecture, security, threat-model, and tool-reference documents have been aligned with the current implementation.

Current limits remain: no cancellation or timeout, no persistence across restart, no caller authentication or remote service, and no OS-level read containment for ordinary read-only tasks. Every proposal still requires human review.

This document describes a release candidate. It does not assert that a Git tag, GitHub Release, or npm publication has been created.
