# 下一版多工作台调度 / Codex + DSH 并存 Implementation Plan

> 本文件是本版本唯一的边界真源（single source of truth）。实现、评审和验收只能以此处明确写出的范围为准；任何未写明的扩展必须先单独修订本计划并经人工评审，不能在实现时顺手加入。

**目标：** 在不改变旧调用行为的前提下，让每个 `run_task` 可显式选择 `codex` 或 `dsh`，并让真实 DSH 的只读结果进入现有 `task_result` 生命周期。

**架构：** `CodexExecutor` 与新增的 `DshExecutor` 平级实现现有 `Executor` seam，长期作为两张独立工作台并存。Bridge 只在 task 边界解析选择、保存选择并创建对应 executor；它不接管任一工作台自身的配置或生态。

**技术栈：** Node.js 22、TypeScript、MCP stdio、Zod、`node:test`，以及 DSH 官方稳定机器接口。

## 全局约束

- `CodexExecutor` 与 `DshExecutor` 是平级、长期并存的两张工作台。DSH 不是 Codex 的替代品，也不是迁移目标。
- Chat/调用方按每个 task 显式选择 executor；不存在进程级、workspace 级或全局切换。
- `run_task.executor` 是可选枚举 `"codex" | "dsh"`，省略时必须规范化为 `"codex"`。所有旧调用的路径、状态和结果保持不变。
- 第一阶段只交付只读 `run_task` 到 DSH 的路由，以及 DSH 最终文本通过现有 `task_result` 生命周期回传。
- 现有 Codex 执行路径、默认行为、workspace 注册与权限检查均不迁移、不重写。
- 第一阶段范围内，`generate_controlled_patch`、`refine_controlled_patch`、精确 `APPLY` 与 `apply_controlled_patch` 继续只走现有 Codex 默认路径，不把它们路由到 DSH，也不改变其状态、持久化或安全检查；其中 `generate`/`refine` 的该限制已由下文「后续 task：controlled-patch proposal 可选 executor」按 per-call 选择放宽，`apply_controlled_patch` 维持本行全部语义不变（不接受 executor、不调用任何模型、Bridge 自行校验并 git apply）。
- Bridge 只负责调度与控制边界。它不读取、合并、覆盖或管理 DSH/Codex 各自的插件、skills、persona、preset、provider、模型配置或工作台装修。
- 两张工作台可在 Bridge 之外独立定制；本版本不建设插件生态，只保留这条未来可独立装修的边界。
- DSH 接入必须优先使用官方稳定机器接口（官方 SDK 或官方 JSON-RPC seam）。若当前 rc 接口不足，兼容代码只能存在于极薄的 `DshExecutor` adapter 内，不得侵入或 fork DSH。
- DSH 机器接口若不能可靠约束为只读、固定到已注册 workspace root 并禁用权限升级，则 fail closed，不得发布 `executor: "dsh"` 路由。
- 不做 GUI、第三 executor、自动 executor 选择、模型路由、provider 管理、session 迁移或权限模型扩大。
- 不修改 README、版本号或发布元数据；不以本工作为理由重构无关架构。
- 以下三条是 supervisor/协作调度规则，不是本版本新增 Bridge runtime 锁的实现要求：不同 workspace / 不同项目允许并行执行工程 task。
- supervisor/协作调度应保证同一 workspace 同时最多只能有一个会修改工作树的 active engineering task，以避免 base HEAD、proposal 与 `APPLY` 冲突。
- supervisor/协作调度下，只读 task 在不干扰同一 workspace 写任务的前提下可以并行。
- 本版本不得新增全局锁或 workspace 锁机制；只需保证 per-task executor 选择不引入全局阻塞，不同 workspace 可并行。
- 现有 controlled patch 的 base HEAD 与 `APPLY` 安全检查保持不变。
- Codex 与 DSH 的 executor 选择按每个 task 独立确定，不存在全局 executor 锁；不得因某个 workspace 正在使用 Codex 或 DSH 而阻塞其他 workspace 使用另一 executor。
- checked-in plan 中的每个单独实现 task 自身仍必须严格按 focused RED → 最小 GREEN → focused tests → 全量 tests → diff check/status 的顺序完成；禁止的是同一 workspace 内并行夹带写入，不是多项目并行。

## 锁定的接口与生命周期

外部 MCP 请求只新增一个可选字段：

```json
{"workspace_id":"repo","instruction":"inspect only"}
{"workspace_id":"repo","instruction":"inspect only","executor":"codex"}
{"workspace_id":"repo","instruction":"inspect only","executor":"dsh"}
```

`mcp-stdio` 使用 `z.enum(["codex", "dsh"]).optional().default("codex")`。未知值必须在创建 task 或启动任何进程之前被明确拒绝，返回 MCP tool error，且不能静默回退到 Codex。

服务内部只增加最小选择类型和规范化后的 task 元数据：

```ts
export type ExecutorName = "codex" | "dsh";

export interface RegisteredWorkspaceTaskRequest {
  readonly workspace_id: string;
  readonly instruction: string;
  readonly executor?: ExecutorName;
}

export type ExecutorFactory = (
  executor: ExecutorName,
  workspaceRoot: string
) => Executor;
```

`runTask` 与 `startTask` 在 task 创建时把缺省值固化为 `codex`，并在 task record 中保存该值。一个 task 在其整个生命周期内不得更换 executor；`control_task` 的后续动作沿用已记录选择，绝不重新自动判断。第一阶段不新增跨 executor 或跨工作台 session 迁移。

外部 `task_result` 响应结构不因本版本扩张。DSH task 复用当前交互生命周期：`queued` → `running` → `waiting_for_supervisor_review`，此时 `task_result.review_output` 是 DSH 的最终文本；现有 `accept` 后转为 `completed`，同一文本由 `task_result.output` 返回。DSH 不新增专属状态、task id 或结果端点。

`DshExecutor` 只实现现有 `Executor.execute(request)` 合约。第一阶段不要求它实现 DSH session 恢复、`steer` 或 `interrupt`；不得为了这些未来能力改造 `Executor` seam。现有 `accept` 仍是 Bridge 内部状态转换；若调用现有 `continue`，必须继续使用该 task 已记录的 `dsh` 且保持只读，但本版本不承诺跨执行的 DSH session 连续性。

## 最小预计改动切面

当前补丁只新增本计划文件。后续实现只允许触及下列最小集合：

- `src/executors/executor.ts`：现有 `ExecutorRequest`/`ExecutorResult` seam 已足够，预期零改动；若真实官方接口证明不够，必须先停止并修订本计划。
- `src/executors/dsh-executor.ts`：新增极薄 adapter。只把 workspace root、instruction 和只读约束映射到已验证的官方机器接口，并把最终文本/安全错误映射为现有 `ExecutorResult`。
- `src/tasks/registered-workspace-task-service.ts`：加入 `ExecutorName`、默认值规范化、per-task 元数据保存，以及按名称调用 `ExecutorFactory`；不改变既有状态机和 workspace 权限解析。
- `src/mcp-stdio.ts`：给 `run_task` 增加可选 `executor` 参数，并在唯一工厂分支创建 `CodexExecutor` 或 `DshExecutor`；第一阶段除 `run_task` 外的其他 MCP tools 不接收 executor 参数（`generate_controlled_patch`/`refine_controlled_patch` 的 executor 参数由下文后续 task 引入）。
- `src/core/errors.ts`：仅在 DSH adapter 需要安全、可区分的失败映射时增加与现有模式对称的 `DSH_UNAVAILABLE`、`DSH_PROTOCOL_ERROR`、`DSH_EXECUTION_FAILED`；不得暴露原始 stderr、配置或凭据。
- `tests/unit/tasks/registered-workspace-task-service.test.ts`：覆盖默认选择、显式选择、task 内选择固定及 Codex 旧路径不变。
- `tests/unit/executors/dsh-executor.test.ts`：新增 adapter 的 focused tests，使用可注入的官方 client/process seam，不依赖开发机 DSH 配置。
- `tests/unit/mcp-stdio.test.ts`：覆盖省略、显式 `codex`、显式 `dsh` 和未知 executor 的 MCP 边界；断言未知值不创建 task、不启动 executor。
- `tests/unit/errors.test.ts`：仅当加入上述 DSH 错误码时同步覆盖稳定的安全序列化。

不新增 executor registry、全局 selector、provider abstraction、配置数据库或通用插件层。两分支的最小工厂 `switch` 足够；第三个 executor 出现之前不得抽象化。

DSH 官方 SDK 若需要新增依赖，必须先由人工确认官方包名、版本与许可，并通过单独的计划修订授权 `package.json`/lockfile 变更；在此之前优先使用真实已安装 DSH 暴露的官方稳定 JSON-RPC seam。不得猜测 rc 私有协议，也不得以 fork、patch DSH 或把协议逻辑散落到 service/MCP 层来绕过此门槛。

## 单一实施 task

### Task 1：只读 per-task executor 路由

**接口输入：** 上述 `ExecutorName`、`RegisteredWorkspaceTaskRequest` 与 `ExecutorFactory` 签名。

**接口输出：** 旧请求和显式 `codex` 创建 `CodexExecutor`；显式 `dsh` 创建 `DshExecutor`；两者都使用同一个 task id、只读 workspace 检查与 `task_result` 状态机。

- [ ] **Step 1 — focused RED：先写且只写失败测试。**

  在 task-service 测试中用 recording factory 断言：省略 executor 得到 `codex`，显式 `codex` 得到 `codex`，显式 `dsh` 得到 `dsh`，同一 DSH task 的后续执行仍得到 `dsh`。在 MCP 测试中断言 schema 接受前述三种合法请求并拒绝 `executor: "unknown"`，拒绝路径没有 task id 和子进程调用。在 DSH adapter 测试中用 fake 官方 seam 固定只读 cwd、原样 instruction、completed output、unavailable、protocol error 和 execution failure 的期望。运行 focused tests，确认失败原因只对应尚未实现的选择/adapter 行为。

  ```sh
  npm run build
  node --test dist/tests/unit/tasks/registered-workspace-task-service.test.js dist/tests/unit/executors/dsh-executor.test.js dist/tests/unit/mcp-stdio.test.js
  ```

- [ ] **Step 2 — 最小 GREEN：只实现测试要求的路径。**

  先在真实已安装 DSH 上确认官方文档/自描述能力提供的稳定 SDK 或 JSON-RPC 调用、终止事件及只读约束。随后实现一个薄 `DshExecutor`，协议解析、rc 兼容与错误归一化全部留在该文件；service 只能看见 `ExecutorResult`。在 task-service 创建时规范化并保存 executor；在 `mcp-stdio` 的两分支工厂中实例化对应 executor。不要移动或重写 `CodexExecutor`，不要改变 controlled patch 调用。

  ```ts
  switch (executor) {
    case "codex": return new CodexExecutor(workspaceRoot);
    case "dsh": return new DshExecutor(workspaceRoot);
  }
  ```

- [ ] **Step 3 — focused tests：证明边界和回归。**

  运行 typecheck/build 和三个 focused test 文件。另运行 controlled-patch focused tests，证明未带 executor 的内部调用仍选择 Codex，controlled patch/refine/APPLY 行为未迁移。

  ```sh
  npm run typecheck
  npm run build
  node --test dist/tests/unit/tasks/registered-workspace-task-service.test.js dist/tests/unit/executors/dsh-executor.test.js dist/tests/unit/mcp-stdio.test.js dist/tests/unit/tasks/controlled-patch-service.test.js
  ```

  然后在真实已安装 DSH 上，用已注册 workspace 发起一个不会写文件的 `run_task`：先省略 executor 验证 Codex，再显式 `codex` 验证 Codex，最后显式 `dsh` 执行只读检查。轮询 `task_result`，验证 DSH 文本先作为 `review_output` 返回，执行现有 `accept` 后同一文本作为 `output` 返回；检查 workspace Git 状态未变化。未知 executor 必须返回明确 tool error，且两张工作台均未启动。

- [ ] **Step 4 — 全量 tests：只在 focused 全绿后执行。**

  ```sh
  npm test
  ```

  必须保持所有现有测试为绿；任何 Codex、workspace 权限或 controlled patch/refine/APPLY 回归都阻止完成。

- [ ] **Step 5 — diff check/status：最后检查唯一范围。**

  ```sh
  git diff --check
  git status --short
  ```

  人工核对 diff 只包含本节列出的最小文件；不得出现 README、`package.json`、lockfile、版本号、GUI、插件生态、provider/model 配置或无关重构。

## 后续 task（已批准）：controlled-patch proposal 可选 executor

> 本 task 放宽上文对 proposal 生成/refine 的 Codex-only 限制，是 proposal 路由的当前边界真源；`apply_controlled_patch` 不在放宽范围内，语义保持上文与本节不变。

- `generate_controlled_patch` 接受可选 `executor: "codex" | "dsh"`，省略时默认 `"codex"`。
- `refine_controlled_patch` 接受可选 `executor: "codex" | "dsh"`，省略时默认 `"codex"`。
- executor 选择是 per-call 的；refine 不要求继承 parent proposal 的 executor，parent 为 dsh 时省略 executor 的 refine 仍默认 codex。
- DSH 可以生成 retained read-only proposal，经现有 generate/refine 返回与 retained 状态生命周期交付 human review；proposal generation 仍然不写工作区。
- proposal task 继续走现有 legacy/non-interactive 任务路径，不升级为交互任务；不新增 `waiting_for_supervisor_review`、review_output、continue、steer、interrupt 或 accept 语义。
- retained proposal 记录真实 executor 并持久化；旧记录缺省为 codex；非法 executor 按现有 retained-state fail-closed / quarantine 语义处理，不得静默降级为 codex。retained envelope 保持 version 1 向后兼容（可选字段，不 bump state version）。
- DSH proposal generation 失败时沿用现有失败清理语义（不伪装成功、unpin/delete、不留下不可用 retained proposal），复用现有 `DSH_UNAVAILABLE`、`DSH_PROTOCOL_ERROR`、`DSH_EXECUTION_FAILED` 错误码，不新增错误码。
- `apply_controlled_patch` 不接受 executor，不调用任何模型（不调用 Codex 也不调用 DSH）；仍要求 write authorization、base HEAD 与 clean worktree 校验、parser 与 `git apply --check` 检查、精确 `"APPLY"` 确认，并仍由 Bridge 自己 `git apply`。DSH 始终不获得直接写工作区的权限。
- 不改变 executor architecture：proposal task 复用现有 `Executor` seam 与唯一 `ExecutorFactory` 分支；不新增 session/resume 语义、executor registry、selector 或 provider 层。

## 完成判据

- 旧 `run_task` 不带 executor 参数时继续走 Codex，外部行为与状态生命周期不变。
- `executor: "codex"` 明确走 Codex。
- `executor: "dsh"` 在真实已安装 DSH 上完成一个只读 workspace task，并由现有 `task_result` 返回最终文本。
- 未知 executor 在 task 创建和进程启动前被明确拒绝，绝不回退。
- `CodexExecutor`、workspace 权限、controlled patch、refine 与精确 `APPLY` 路径没有迁移或重写。
- Bridge 没有获得或管理任一工作台的插件、skills、persona、preset、provider 或模型配置。
- focused tests、真实 DSH 验收和 `npm test` 全绿，`git diff --check` 通过，最终 status 只有获准的最小切面。
