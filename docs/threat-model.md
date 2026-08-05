# Threat model

Engineering Bridge v0.2.0-alpha.2 assumes one trusted local operator controls the startup configuration and local MCP client. It is not designed for untrusted remote callers.

| Risk | Current control | Remaining responsibility or limit |
|---|---|---|
| Caller chooses an arbitrary workspace | MCP accepts only a registered ID; roots come from startup configuration | Operator must protect and review the configuration file |
| Codex modifies files during analysis | Fixed read-only Codex invocation | Same-user reads are not contained to the workspace |
| Caller text becomes a shell command | No shell; instruction is written to stdin | Codex still interprets natural-language instructions |
| A patch escapes through its path | Patch parser rejects absolute, non-normalized and `..` paths; Git tree lookup requires tracked regular files | Human must review all valid in-workspace targets and semantics |
| Repository changes between review and apply | HEAD and clean tracked state are rechecked | A failed proposal may be retried only after preconditions are restored |
| Symlink or mode change writes outside the workspace | Symlink/mode patches and non-regular Git entries are rejected | Read-only tasks still lack symlink/read containment |
| Sensitive executor errors leak | stderr and partial failure output are discarded; fixed errors are returned | Reduced diagnostic detail; no persistent redaction/logging system exists |
| Automatic publication occurs | Apply uses only `git apply`; no test, add, commit or push command exists | User remains responsible for every later Git operation |
| Restart reports stale task state | State is deliberately process-local | Tasks and proposals disappear on restart; no recovery is promised |
| Long-running task consumes resources | No current control | Cancellation, timeout and resource quotas are not implemented |

Prompt wording improves proposal quality but is not treated as an enforceable control. Code validation and human review are separate and both necessary.
