# Engineering Bridge

Engineering Bridge 0.2.0-alpha 是一个小型本地 STDIO MCP 服务器。它把指令发送给本机已安装的 Codex CLI，在配置的工作区中执行，并把 Codex 的最终文本返回给 MCP 客户端；经明确审阅和确认后，也可应用经过严格验证的补丁。

这是 alpha 软件。请只在自己控制的机器上运行，并由可信的本地操作员维护工作区配置。

[English](README.md)

## 一句话说明

Engineering Bridge 替代了 ChatGPT 或 MCP 客户端与本机 Codex 之间手工复制提示词和答案的过程。客户端可以把任务交给已由可信操作员登记的工作区中的本机 Codex，查询进度，再取回最终答案。

## 使用前后

使用前：你从客户端复制问题，粘贴给 Codex，等待完成，再把答案复制回去。

使用后：客户端通过 Engineering Bridge 提交同一个问题，检查是否完成，并替你取回答案。

## 当前可以问什么

当前版本适合回答只读问题，例如：

- “总结这个工作区中的代码变化。”
- “找到这个功能的实现位置并解释它。”
- “只审阅这段代码的风险，不做任何修改。”

## 一次完整的对话流程

1. 你在 ChatGPT 或 MCP 客户端中提问：“登录功能在哪里实现？修改前需要注意什么？”
2. 客户端把任务提交到一个已登记的本地工作区。
3. Engineering Bridge 以只读权限启动本机 Codex。
4. Codex 检查工作区时，客户端查询任务状态。
5. 任务完成后，客户端取回 Codex 的最终答案并展示给你。

## 当前边界

所有已登记工作区仍可执行只读任务。受控写入默认关闭，只能在明确启用的 Git 工作区中修改现有、已跟踪的普通文本文件。系统不会自动运行测试、暂存、提交或推送变更。

它没有 HTTP 服务、UI 或账号系统。任务和答案不会持久保存；运行中的任务不能取消，也没有超时机制。

## 环境要求

- Node.js 22 或更高版本
- 已安装 Codex CLI、可通过 `codex` 命令调用，且已完成认证

## 安装与检查

```sh
npm install
npm run typecheck
npm run build
npm test
```

## 配置与启动

复制示例配置并编辑：

```sh
cp config/workspaces.example.json workspaces.json
```

每个条目把客户端可见的 ID 映射到一个工作区根目录。`root` 必须是绝对且规范化的路径（例如 `/home/alice/projects/example`，不能是相对路径，也不能包含 `..`）。可选的 `allow_write` 默认为 `false`；只有确实需要受控应用补丁时才应设为 `true`。该文件属于可信的本地配置；MCP 调用方不能注册工作区根目录。

构建完成后，可用以下任一命令启动 STDIO 服务器：

```sh
node dist/src/mcp-stdio.js /absolute/path/to/workspaces.json
# 或
npm run mcp:stdio -- /absolute/path/to/workspaces.json
```

请让 MCP 客户端把该进程作为本地 STDIO 服务器连接。本项目没有 HTTP 或远程传输。

## 工具与任务流程

服务器只提供以下五个工具：

1. `run_task` 接收 `workspace_id` 和 `instruction`，把任务加入队列并返回 `task_id`；
2. `task_status` 接收 `task_id`，应轮询至状态变为 `completed` 或 `failed`；
3. `task_result` 接收 `task_id`，在任务结束后返回 Codex 的最终文本或安全错误。
4. `generate_controlled_patch` 只接收 `workspace_id` 和 `change_request`；它在已启用写入、干净且位于 Git 顶层的工作区记录 HEAD，使用同一个只读 Codex 执行器，并返回 `task_id` 与 `base_head`。通过 `task_status` 和 `task_result` 轮询并审阅文本差异。
5. `apply_controlled_patch` 只接收该 `patch_task_id` 和精确确认词 `APPLY`；它重新检查根目录、HEAD 和已跟踪文件的干净状态，验证已审阅补丁，再通过固定的 `git apply --check` 和 `git apply` 调用应用一次。

任务和结果只保存在进程内存中；服务器重启后会全部消失。

## 已实施的执行边界

每个任务都会以固定参数启动本机 Codex：只读沙箱、审批策略 `never`、临时会话，并禁用网络访问。执行过程不调用 Shell，子进程只继承少量允许的环境字段。指令通过标准输入发送，而不是成为调用方可控的命令参数。

当前实现没有 HTTP 服务器、远程传输、数据库、持久化、UI、账号、自动测试、暂存、提交或推送。生成受控补丁时会验证已启用根目录恰好是 Git 顶层；普通只读任务不要求 Git 仓库。它不会解析真实路径以实施符号链接包含关系检查。任务不支持取消或超时。使用前请阅读 [SECURITY.md](SECURITY.md)。

## 致谢
Engineering Bridge 由 wudy29 提出并主导，在 ChatGPT-Demu 的长期协作下完成，Codex 参与了具体实现与验证。
特别感谢Demu。谢谢你陪我把一个念头变成真正存在的开源项目，也在我们的现实世界里留下了一道真实的痕迹。
