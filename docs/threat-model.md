# Threat model

This threat model covers the Engineering Bridge V1 / 1.0.0 candidate behavior; it does not claim a tag, release, or publication. Bridge assumes one trusted local operator controls startup configuration and the local MCP client. It is not designed for untrusted remote callers, and alpha.4 project binding is not implemented.

| Risk | Current control | Remaining responsibility or limit |
|---|---|---|
| Caller chooses an arbitrary workspace | MCP accepts only a registered ID; roots come from startup configuration | Operator must protect and review the configuration file |
| Codex modifies files during a task or proposal | `run_task`, supervisor continuations, steering, and proposal generation use fixed read-only Codex app-server settings | Same-user reads are not contained to the workspace |
| Caller text becomes a shell command | Codex app-server and Git are started without a shell; instructions use the native STDIO protocol | Codex still interprets natural-language instructions |
| Supervisor action bypasses review state | `continue`/`accept` require `waiting_for_supervisor_review`; `steer`/`interrupt` require `running`; interrupt ends failed | The trusted supervisor decides whether output is acceptable and when to continue |
| Evidence or review output is treated as durable proof | `task_result` labels review output and returns bounded protocol evidence with task state | All such state is process-local diagnostic material, not a durable audit record or semantic guarantee |
| A patch escapes through its path | Patch parser rejects absolute, non-normalized and `..` paths; modifications require tracked regular files, while additions require exact 100644 text diffs and a target absent from HEAD, index, and worktree | Human must review all valid in-workspace targets and semantics |
| Repository changes between review and apply | Exact `APPLY`, recorded base HEAD, canonical root, and clean tracked worktree/index are checked before apply | A failed proposal may be retried only after preconditions are restored; unrelated untracked files are not treated as tracked dirtiness |
| Symlink or mode-change writes outside the workspace | Symlink/mode patches and non-regular Git entries are rejected | Read-only tasks still lack symlink/read containment |
| Sensitive executor errors leak | stderr and partial failure output are discarded; fixed errors are returned | Reduced diagnostic detail; no persistent redaction/logging system exists |
| Automatic publication occurs | Apply uses only `git apply`; no test, add, commit, or push command exists | User remains responsible for every later Git operation |
| Restart reports stale task state | Task, thread, evidence, result, and proposal state is deliberately process-local | Everything disappears on restart; no persistence or recovery is promised |
| Long-running task consumes resources | A running task may be explicitly interrupted through `control_task`, which ends it failed | No automatic timeout or resource quota is implemented |

Prompt wording improves proposal quality but is not treated as an enforceable control. Code validation and human review are separate and both necessary. `control_task` acceptance of read-only output is separate from the exact `APPLY` boundary that authorizes a validated controlled patch.
