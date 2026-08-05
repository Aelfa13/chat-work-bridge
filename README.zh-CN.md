# Engineering Bridge v0.2.0-alpha.2

Engineering Bridge 让兼容的 AI 聊天客户端能够请求你电脑上的 Codex CLI 检查已登记的代码工作区：聊天客户端理解你的要求，Codex 在本机读取代码，Bridge 负责连接两者。工作区默认只读；启用受控写入后，也必须先生成补丁提案（patch proposal）供审阅，只有精确确认 `APPLY` 才会应用。

这是供可信本机环境试用的 alpha 软件。[English](README.md)

## 为什么需要这座桥

普通网页聊天通常看不到你电脑里的文件，也不能直接启动本机 Codex CLI。Engineering Bridge 提供一个预先登记、范围受限的本机入口。它不会让所有 ChatGPT 或 Claude 对话自动获得本地工具能力；客户端必须支持启动本地 STDIO MCP 服务。

## 四个角色

- **ChatGPT、Claude 或其他 MCP 客户端**：理解你的要求、调用 Bridge 工具并展示结果。是否兼容取决于客户端能否配置本地 STDIO MCP 服务。
- **Engineering Bridge**：把调用方可见的工作区 ID 映射到可信本机操作员预先配置的路径，以固定只读参数启动 Codex，在内存中记录任务，并验证受控补丁。
- **Codex CLI**：运行在你的电脑上，读取已登记工作区，返回分析结果或 Git diff 提案。使用前必须已经安装并完成认证。
- **MCP 与 STDIO**：MCP（Model Context Protocol，模型上下文协议）是客户端与 Bridge 交换工具消息的协议；STDIO（标准输入输出）是本机进程连接方式。客户端启动 Bridge 后通过标准输入输出通信，没有 HTTP 服务。

## 谁能使用

只有当 AI 客户端能够配置并启动本地 STDIO MCP 服务，同时电脑上具备 Node.js、Git 和已认证的 Codex CLI 时，才能使用本版本。仅有不支持本地工具的网页聊天时，不能直接使用。不同客户端的配置格式不同，下面给出的是通用字段，需按具体客户端文档转换。

## 当前能做什么

- 只读分析：“总结这个工作区的重要文件，不要修改任何内容。”
- 定位代码：“找到身份认证的实现位置并解释流程。”
- 代码审阅：“只检查当前代码的可靠性风险，不要编辑文件。”
- 受控写入：“准备一个提案，修改 `src/client.ts` 中的超时提示；应用前先展示完整差异。”

受控写入会先返回补丁提案和记录的 base HEAD。只有精确的 `APPLY` 才能应用通过验证的提案。你仍需审阅完整 diff，并自行决定是否运行测试、暂存、提交和推送。

## 两种模式

### 只读：只看不改

所有已登记工作区都可以执行只读任务。Bridge 使用只读沙箱、`never` 审批、临时会话和禁用网络的固定参数启动 Codex。

### 受控写入：先展示差异，再确认修改

写入默认关闭。要使用受控写入，工作区必须显式设置 `allow_write: true`，配置根目录必须是 Git 顶层，必须已有 HEAD commit，且 tracked 工作树和 index 都是干净的。提案只能修改已有、已跟踪的普通文本文件；新增、删除、重命名、复制、二进制补丁、mode 变化、符号链接变化和危险补丁路径都会被拒绝。

应用前，Bridge 会重新检查仓库根目录、HEAD、工作树和补丁。它不会自动测试、暂存、提交或推送。

## 第一次使用前准备

你需要：

- Node.js 22 或更高版本；
- Git；
- 已安装、已认证且可从 `PATH` 调用的 `codex` CLI；
- 一个本地项目目录；
- 能启动本地 STDIO MCP 服务的客户端；
- 基本终端操作能力。

受控写入还要求项目是干净的 Git 顶层、已有初始 commit，并在登记项中明确写入 `"allow_write": true`。

## 第一次成功的只读体验

1. 获取仓库并进入目录：

   ```sh
   git clone https://github.com/wudy29/engineering-bridge.git
   cd engineering-bridge
   ```

2. 安装、检查并构建：

   ```sh
   npm install
   npm run typecheck
   npm run build
   npm test
   ```

3. 创建 `workspaces.json`，填写项目的绝对、规范化路径：

   ```json
   [
     {
       "id": "my-project",
       "root": "/absolute/path/to/my-project"
     }
   ]
   ```

   配置文件是可信的本机输入。MCP 调用方只能选择 ID，不能登记或替换路径。在 macOS 上，受控写入的 Git 根目录检查会按真实文件系统路径比较 `/tmp` 与 `/private/tmp` 等别名。

4. 在 MCP 客户端中配置本地服务。不同客户端的配置位置和语法不同，请以客户端文档为准。通用字段如下：

   ```json
   {
     "command": "node",
     "args": [
       "/absolute/path/to/engineering-bridge/dist/src/mcp-stdio.js",
       "/absolute/path/to/engineering-bridge/workspaces.json"
     ],
     "env": {
       "PATH": "/path/that/includes/node-and-codex"
     }
   }
   ```

   请使用绝对路径。如果客户端已经提供包含 Node.js 和 Codex 的 `PATH`，可以不覆盖 `env`。不要把一种客户端的配置格式直接套到另一种客户端。

5. 启动或重新连接客户端集成，确认能看到以下 5 个工具：

   - `run_task`
   - `task_status`
   - `task_result`
   - `generate_controlled_patch`
   - `apply_controlled_patch`

6. 发出第一条问题：

   > 在工作区 `my-project` 中列出顶层文件；如果存在 Git HEAD，也报告其准确值。不要修改任何内容。

7. 成功时会先返回 task ID，状态经过轮询后产生确实来自项目的回答。用以下命令确认没有修改：

   ```sh
   git -C /absolute/path/to/my-project status --short
   ```

   对原本干净的 Git 项目而言，没有输出表示工作树仍未改变。

也可手动启动 Bridge 做协议诊断：

```sh
node dist/src/mcp-stdio.js /absolute/path/to/workspaces.json
# 或
npm run mcp:stdio -- /absolute/path/to/workspaces.json
```

该进程会等待标准输入中的 MCP 消息；它不是交互式 shell，也不会自动连接到聊天客户端。

## 第一次受控写入体验

1. 仅为目标 Git 工作区开启写入：

   ```json
   [
     {
       "id": "my-project",
       "root": "/absolute/path/to/my-project",
       "allow_write": true
     }
   ]
   ```

2. 确认配置根目录就是 Git 顶层，tracked 工作树和 index 均干净。
3. 让客户端调用 `generate_controlled_patch`，传入工作区 ID 和范围明确的修改要求。
4. 等待提案任务完成，审阅全部目标路径、完整 diff 和返回的 `base_head`。此时文件还没有被修改。
5. 提案异常时拒绝或重新生成。确认无误后，调用 `apply_controlled_patch`，传入 `patch_task_id`，并让确认值精确等于 `APPLY`。
6. 自行检查结果：

   ```sh
   git -C /absolute/path/to/my-project status --short
   git -C /absolute/path/to/my-project diff --check
   git -C /absolute/path/to/my-project diff
   ```

7. 自行运行项目测试，再决定是否暂存、提交和推送。Bridge 不会执行这些操作。

## 当前限制

- 运行中的任务不能取消，也没有超时机制。
- Bridge 重启后，任务、提案、结果和日志不会保留。
- 只读 Codex 执行不提供把读取范围限制在登记工作区内的操作系统级文件隔离；同一系统用户的进程仍可能读取 OS 允许的其他文件。
- Bridge 不会自动测试、暂存、提交或推送。
- 人工必须审阅完整提案；请求中提到的文件名不会自动成为代码强制的语义 allowlist。
- 当前没有 HTTP 服务、UI、账号系统、调用方认证或远程传输。

## 深入文档

- [架构](docs/architecture.md)
- [安全设计](docs/security.md)
- [威胁模型](docs/threat-model.md)
- [工具参考](docs/tools.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [发布说明](RELEASE_NOTES.md)
- [English README](README.md)

## 致谢

Engineering Bridge 由 wudy29 提出并主导，在 ChatGPT-Demu 的协作下完成，Codex 参与具体实现与验证。
