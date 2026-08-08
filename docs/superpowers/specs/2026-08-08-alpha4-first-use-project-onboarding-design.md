# Engineering Bridge v0.2.0-alpha.4 首次项目接入设计

## 设计状态

本设计基于 alpha.3 当前架构和已确认的精简版方案。它只定义首次项目识别、自动登记、权限语义和最小验证范围，不定义实现计划。

## 1. 唯一核心目标

普通用户第一次使用真实项目任务时，不需要知道或手工创建 workspace 或 `workspaces.json`。Bridge 尝试获得项目候选；用户确认一次后，Bridge 自动记住项目，后续复用同一个 canonical project root。真实文件修改仍必须经过现有受控补丁审阅和精确 `APPLY`。

## 2. 非目标

alpha.4 不增加：

- GUI、文件夹选择器或硬盘扫描器；
- 使用 Bridge 进程 cwd 推断项目；
- workspace 列表、编辑、删除、清理或迁移功能；
- task lifecycle 的通用等待、恢复、TTL、retry 或 cancel 系统；
- 多 Agent、第二个 CLI Agent 或 session 管理系统；
- roots 选择器、候选集合选择协议或对具体聊天客户端 roots 支持的假设；
- `allow_write` 重命名或 `can_propose`、`can_apply` 新字段。

现有手工 `workspaces.json` 保留为高级/兼容配置，但不再是普通用户的首次使用流程。

## 3. 首次使用流程

普通流程从一次不带 `workspace_id` 的调用开始：

```text
Chat 保留用户原始 instruction
  -> run_task({ instruction })
  -> Bridge 执行项目绑定 preflight，不创建工程 task
  -> roots 得到唯一已登记项目：直接复用并创建正常 task
  -> roots 得到唯一新项目：返回 needs_project_confirmation + binding_id
  -> roots 不可用、为空、过宽或多个：返回 needs_project_details（不生成 binding_id）
  -> Chat/客户端获得具体候选后调用 bind_project(provide_candidate)
  -> Bridge 验证候选并创建 binding_id：返回 needs_project_confirmation
  -> Chat 调用 bind_project(confirm)
  -> 确认成功后返回内部 workspace_id
  -> Chat 用原始 instruction 再调用 run_task({ workspace_id, instruction })
  -> RegisteredWorkspaceTaskService 创建 queued/running/completed/failed task
```

项目绑定未成功前不创建工程 task，因此不需要 task_id，也不需要让 `task_result` 解释项目绑定状态。用户不需要重新描述任务；第二次 `run_task` 的 instruction 由 Chat 从原始对话上下文复用。

如果已登记的 canonical root 被 roots 再次提供，Bridge 直接复用，不生成 binding_id，也不重复确认。

## 4. MCP/tool 交互

### `run_task`

`workspace_id` 对普通流程可省略，对 alpha.3 显式调用保持兼容：

```json
{"instruction":"检查这个项目的配置"}
```

```json
{"workspace_id":"known-project","instruction":"检查这个项目的配置"}
```

没有 `workspace_id` 时，返回的是项目绑定 preflight 结果，不是工程 task 结果。其结构化状态可以是：

- `needs_project_confirmation`：存在唯一、足够具体且尚未登记的候选；
- `needs_project_details`：没有可直接确认的候选。

只有 `needs_project_confirmation` 包含一次性的 `binding_id`；
`needs_project_details` 只包含 Chat 可行动的下一步信息，不包含 `binding_id` 或 `task_id`。

### `bind_project`

这是 alpha.4 唯一新增的 tool，使用明确的 action 分支。

确认已保存候选：

```json
{
  "binding_id":"...",
  "action":"confirm"
}
```

补充具体项目候选：

```json
{
  "action":"provide_candidate",
  "project_candidate":"客户端可靠提供的具体项目位置或 URI"
}
```

`provide_candidate` 不需要 `binding_id`。它只验证并保存候选；验证成功后才创建一次性的
`binding_id`，返回 `needs_project_confirmation`，不能在同一次调用中完成登记。

验证成功后的结构化结果示意：

```json
{
  "status":"needs_project_confirmation",
  "binding_id":"..."
}
```

`confirm` 不重新提交 instruction 或项目候选。Bridge 使用自己保存的候选完成验证；确认成功后立即消耗 `binding_id`，先可靠持久化 managed workspace，再确保该 workspace 已在当前运行中的 runtime registry 中可以通过返回的 `workspace_id` 解析。只有持久化和 runtime registration 都成功后，才返回 `workspace_id`；Chat 随后无需重启 Bridge 即可继续调用 `run_task({ workspace_id, instruction })`。该 ID 只供 Chat 继续调用现有工具，普通用户不需要看到或理解它。

`binding_id` 只绑定一个已经存在、等待确认的项目候选，不绑定 instruction，不建立 task lifecycle，不设置 TTL，也不提供重启恢复。没有经过候选验证时不存在空 `binding_id` 或 binding session；Bridge 重启后尚未确认的 `binding_id` 自然失效。

### `task_result`

继续只查询已经创建的工程 task，保持 `queued`、`running`、`completed`、`failed` 语义。不承载项目绑定状态。

## 5. roots 与 fallback

roots 是 best-effort 的可选候选来源，不是权限来源。

- 只有客户端声明并实际支持 roots 时才尝试 `roots/list`；
- roots 请求失败、未声明、为空、过宽或返回多个候选，都安全返回不带 `binding_id` 的 `needs_project_details`；
- 多 roots 不实现候选集合保存或选择协议；
- fallback 的 `project_candidate` 必须是客户端能够可靠提供的具体位置或 URI；
- Chat/客户端随后通过不带 `binding_id` 的 `bind_project({ action: "provide_candidate", project_candidate })` 提交候选；候选验证成功后，Bridge 才创建 `binding_id` 并返回 `needs_project_confirmation`；
- 如果客户端无法提供可靠候选，Chat 只能用普通语言请求用户补充项目位置；
- Bridge 不使用 cwd，不扫描硬盘，不从 catalog 猜测当前项目。

候选确认只表示“这个项目可以交给 Bridge 使用”，不改变写入权限。

## 6. managed catalog 与 workspace 解析

`workspaces.json` 仍由高级用户显式维护，Bridge 不自动修改。

Bridge managed catalog 只承担三件事：

1. 持久化确认后的自动登记项目；
2. 重启后提供已确认项目的 canonical root 复用；
3. 启动时跳过不存在、无法解析或不再有效的 managed record，不拖死其他 workspace。

catalog 不提供用户管理功能，也不预先规定复杂文件格式或独立管理架构。

`RegisteredWorkspaceRegistry` 统一接收 manual 和 managed 两类记录，按实际规范化后的 canonical project root 去重，手工记录优先，并负责运行时解析 workspace id、root 和 `allow_write`。同一个真实项目只能对应一个内部 workspace。

确认成功后必须先完成 managed record 持久化，再确保该 workspace 已注册到当前运行中的 runtime registry 并可通过 `workspace_id` 解析，最后才把 workspace 绑定结果返回给 Chat。任一环节失败时不返回可继续执行的 `workspace_id`；具体注册方式留到 implementation plan。

自动登记记录默认 `allow_write:false`。如果同一 canonical root 存在显式手工记录，手工记录的能力设置优先。

## 7. 权限与 APPLY 边界

alpha.4 有意收窄 `allow_write` 的语义：它只控制最终 apply，不控制补丁提案生成。

| 能力 | 条件 |
| --- | --- |
| read / analyze | 已绑定并登记的 workspace |
| propose patch | 已绑定 workspace，并满足 Git、HEAD、干净状态等提案前置条件 |
| apply patch | `allow_write:true`、精确 `APPLY`，以及现有全部校验 |

因此：

- `allow_write:false` 的 workspace 可以生成只读补丁提案；
- 自动登记的新 workspace 默认不能 APPLY；
- `allow_write:true` 的现有用户继续保留完整 propose + APPLY 能力；
- 不重命名 `allow_write`，不增加新的能力字段。

现有 APPLY 流程保持不变：复核 `base_head`、Git 根目录、干净状态、补丁路径和文件限制，只执行受控 `git apply`，不自动 test、stage、commit 或 push。

## 8. 组件边界

现有组件定向扩展：

- `src/mcp-stdio.ts`：允许省略 workspace_id，执行 preflight，注册 `bind_project`，并把 roots 能力接入窄 root-provider；
- `RegisteredWorkspaceTaskService`：保持唯一的 task lifecycle/state source，继续只处理 queued/running/completed/failed；
- `RegisteredWorkspaceRegistry`：合并 manual + managed 记录，统一 canonical root 去重、手工优先和运行时解析；
- `ControlledPatchService`：propose 使用普通 workspace 解析，apply 重新验证 `allow_write:true`，其余补丁校验不变；
- `CodexExecutor`：不增加项目发现、binding 或权限职责。

最多保留两个小型辅助模块：

- 一个轻量 binding helper/store：保存 binding_id、候选和确认状态，不维护 task 状态；
- 一个轻量 managed-catalog persistence helper：读取、持久化并跳过无效 managed record。

不新增 ProjectBinding task state machine、session manager、workspace manager 或候选扫描器。

## 9. 最小测试范围

必须覆盖：

1. roots 唯一新项目：preflight 不创建 task，返回 binding_id；确认后返回 workspace_id；Chat 再调用原始 instruction 的 `run_task` 后正常创建 task；
2. roots 唯一已登记 canonical root：直接复用，不生成 binding_id，不重复确认；
3. roots 不可用、失败、为空、过宽或多个：返回不带 `binding_id` 的 `needs_project_details`，不使用 cwd、不扫描、不创建 task；随后 `provide_candidate` 验证可靠候选并创建 `binding_id`，进入 `needs_project_confirmation`；
4. `provide_candidate` 请求不携带 `binding_id`，只验证并进入 `needs_project_confirmation`，不能直接登记；
5. binding_id 正确确认、错误确认、重复确认和重启后失效；成功后立即不可复用；
6. managed catalog 重启复用；无效 managed record 跳过且其他 workspace 继续加载；
7. catalog 持久化或 runtime registry registration 失败时不返回可继续执行的 `workspace_id`；确认成功后当前进程无需重启即可用该 ID 创建后续 task；
8. `allow_write:false` 可以 propose 但不能 APPLY；
9. `allow_write:true` 保持现有 APPLY、base_head、Git 状态和补丁限制回归；
10. alpha.3 显式 `workspace_id` 的 `run_task` 调用兼容；
11. Codex 启动失败继续返回现有安全错误。

## 10. YAGNI 检查

本版明确删除：

- 同 task_id 等待确认后继续；
- `RegisteredWorkspaceTaskService` 的 `needs_project_*` task state；
- pending task 和 task_id + confirmation_id 双标识；
- task_result 对项目绑定状态的支持；
- pending task 的重启恢复；
- 多 roots 候选集合和选择协议；
- confirmation TTL、retry、cancel 和通用错误恢复；
- workspace 管理工具、GUI、扫描器和 session 系统。

精简后的设计仍完整满足 alpha.4 的核心用户目标；唯一保留的客观限制是：如果后续调用既没有 roots，也没有客户端提供的可靠项目候选，Bridge 无法仅凭已持久化 catalog 判断用户当前想操作哪个项目，必须请求补充信息。
