# Engineering Bridge

**让 Chat 成为工程控制台，让本地 Codex 做执行者：先看补丁，再决定是否写入。**

[![Release v0.2.0-alpha.3](https://img.shields.io/badge/release-v0.2.0--alpha.3-blue)](https://github.com/wudy29/engineering-bridge/releases/tag/v0.2.0-alpha.3)
[![CI](https://github.com/wudy29/engineering-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/wudy29/engineering-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.en.md) · **供可信本机环境试用的 Alpha：**维护者已在 macOS 上使用能启动 STDIO MCP 服务的本地聊天客户端和已认证的 Codex CLI 实测。其他客户端与操作系统尚未验证。

## 以前 / 现在

**以前：**把项目上下文从 ChatGPT 复制到终端或 Codex，再把命令、diff 和结果搬回去，如此反复。

**现在：**在兼容的聊天客户端里描述工程目标。Engineering Bridge 选择预登记的本机工作区，让本机 Codex 检查项目或准备补丁，再把结果送回对话。你审阅完整 diff，并保留是否写入的决定权。

普通浏览器聊天不能天然访问你电脑上的项目，也不能启动 Codex CLI。客户端必须支持启动本地配置的 STDIO MCP 服务。

```mermaid
flowchart LR
    A[Chat 描述目标] --> B[Bridge 选择预登记工作区]
    B --> C[本机 Codex：只读检查或生成补丁]
    C --> D[结果回到 Chat]
    D --> E[人审阅]
    E -->|精确 APPLY| F[重新校验并受控写入]
```

以上全部是本机进程通过 MCP/STDIO 建立的连接。Engineering Bridge 不存在 HTTP 端点或云服务。

## 为什么通过 Chat 控制本地 Agent？

- **对话上下文延续。**需求、取舍和此前结果可以继续参与规划，不必在 ChatGPT、终端与 Codex 之间手工搬运。
- **记忆可以参与规划。**客户端的全局记忆或外部 memory 系统可以提供上下文，但 memory 不是 Bridge 自带的能力。
- **规划端与执行端各司其职。**Chat 梳理目标；本机 Codex 检查真实工作区并给出证据或补丁；Bridge 限定并校验交接过程。
- **执行配置保留选择。**Codex 的模型与供应商配置带来选择和灵活性，但不承诺执行成本更低。
- **人保留最终权限。**你决定补丁是否写入，也决定是否测试、提交、推送或发布。
- **当前实现只有 Codex CLI。**其他 CLI agent 只是未来逐个适配的方向，并非当前支持；本版本只支持并实测 Codex CLI。

## 一个真实案例

本项目曾用 Bridge 生成 CI workflow、Bug Report 模板和 Setup Help 内容。人审阅每份提案并明确执行 `APPLY`；随后由人运行测试、commit、push 并创建 Release，远端 CI 通过。Bridge **没有**自动发布任何内容。

## 能力地图

| 当前可用 | 当前不会做 | Roadmap——不是当前支持 |
| --- | --- | --- |
| 在预登记工作区中进行只读分析、代码定位和审阅 | 不能自动创建或登记工作区 | 简化工作区创建和登记 |
| 写入前生成完整 Git 补丁 | 不自动测试、stage、commit、push 或创建 Release | 逐个适配其他 CLI agent |
| 仅在精确 `APPLY` 后应用，并重新校验 base HEAD 与仓库状态 | 没有 HTTP、UI、账号系统、调用方认证或远程传输 | 谨慎探索多 agent 编排 |
| 修改已跟踪普通文本文件；新增普通 100644 文本文件 | 没有任务取消或超时；不跨重启持久化 | 以上只是方向，不是已支持功能 |
| 通过 STDIO 提供四个本地 MCP 工具 | 不是 OS 级读取隔离 | — |

## Quick Start

### 1. 准备

你需要 Node.js 22+、Git、已安装且已认证并能从 `PATH` 调用的 `codex` CLI、一个本地项目、能启动本地 STDIO 服务的 MCP 客户端，以及基本终端操作能力。

受控写入还要求项目是干净的 Git 顶层、已有初始 commit/HEAD，并在登记项中明确启用 `allow_write`。

### 2. Clone、安装与构建

```sh
git clone https://github.com/wudy29/engineering-bridge.git
cd engineering-bridge
npm install
npm run build
```

这个 Alpha 没有一键安装方式。

### 3. 登记工作区

创建 `workspaces.json`，填入项目的绝对、规范化路径：

```json
[
  {
    "id": "my-project",
    "root": "/absolute/path/to/my-project"
  }
]
```

此文件是可信的本机配置。MCP 调用方只能选择 ID，不能创建、登记或替换路径。在 macOS 上，受控写入的 Git 根目录检查会按真实文件系统路径比较 `/tmp` 与 `/private/tmp` 等别名。

### 4. 配置 STDIO MCP 客户端

不同客户端的配置位置与格式不同；请按照客户端文档转换以下通用字段：

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

请使用绝对路径。如果客户端已经提供合适的 `PATH`，可以省略 `env` 覆盖。不要把此结构原样套入使用其他 schema 的客户端。

重新连接集成，并确认能看到以下四个工具：

- `run_task`
- `task_result`
- `generate_controlled_patch`
- `apply_controlled_patch`

### 5. 第一次只读任务

> 在工作区 `my-project` 中列出顶层文件；如果存在 Git HEAD，也报告其准确值。不要修改任何内容。

成功调用会返回 task ID。轮询 `task_result`：排队或运行中返回 `ready: false`，随后返回结果或安全错误。自行检查工作区：

```sh
git -C /absolute/path/to/my-project status --short
```

对原本干净的 Git 项目而言，没有输出表示工作树仍未改变。

### 6. 第一次受控写入

只为目标工作区开启写入：

```json
[
  {
    "id": "my-project",
    "root": "/absolute/path/to/my-project",
    "allow_write": true
  }
]
```

1. 确认配置根目录就是 Git 顶层、已有 HEAD，且 tracked 工作树和 index 均干净。
2. 调用 `generate_controlled_patch`，传入工作区 ID 和范围明确的要求。
3. 等待任务完成；审阅全部路径、完整 diff 和返回的 `base_head`。此时尚未应用任何修改。
4. 拒绝或修改任何异常提案。确认正确后，调用 `apply_controlled_patch`，传入其 `patch_task_id`，确认值必须精确等于 `APPLY`。
5. 检查结果：

   ```sh
   git -C /absolute/path/to/my-project status --short
   git -C /absolute/path/to/my-project diff --check
   git -C /absolute/path/to/my-project diff
   ```

6. 运行项目测试，再决定是否 stage、commit、push 和发布。Bridge 不会执行其中任何操作。

其他位置的 untracked 文件本身不会破坏 tracked state 干净这一要求，但提案中的新增文件目标必须同时不存在于 HEAD、index 和工作树。

也可以手动启动 Bridge 做协议诊断：

```sh
node dist/src/mcp-stdio.js /absolute/path/to/workspaces.json
# 或
npm run mcp:stdio -- /absolute/path/to/workspaces.json
```

该进程会等待标准输入中的 MCP 消息。它不是交互式 shell，也不会自行连接聊天客户端。

## 安全边界

- 工作区默认只读；受控写入必须按工作区设置 `allow_write: true`。
- 提案会展示完整 diff 和 base HEAD。只有精确 `APPLY` 才会继续；应用前 Bridge 会重新检查 Git 顶层、HEAD、干净的 tracked 工作树与 index，以及补丁有效性。
- 可接受的补丁可以修改已有、已跟踪的普通文本文件，或新增尚不存在、mode 为 100644 的普通文本文件。
- Bridge 拒绝 delete、rename、copy、binary、mode change、executable、symlink、submodule、危险路径等不支持的补丁，也拒绝目标已存在的新增。
- Bridge 不会自动测试、stage、commit、push 或创建 Release。
- 运行中的任务不能取消，也没有超时。任务、提案、结果与日志不会跨重启持久化。
- 只读执行不是 OS 级文件读取隔离；同一系统用户的进程仍可读取操作系统允许的其他文件。
- 人必须审阅完整提案；请求中提到的文件名不会成为代码强制的语义 allowlist。

请阅读[安全设计](docs/security.md)、[威胁模型](docs/threat-model.md)和[工具参考](docs/tools.md)。另见[架构](docs/architecture.md)、[安全策略](SECURITY.md)、[贡献指南](CONTRIBUTING.md)与[发布说明](RELEASE_NOTES.md)。

## 故障排查

- **看不到四个工具：**重新连接客户端，并确认其本地 STDIO MCP 配置启动了 `dist/src/mcp-stdio.js`。
- **客户端找不到 `node` 或 `codex`：**客户端启动的进程可能使用不同于终端的 `PATH`；请提供同时包含这两个可执行文件的路径。
- **工作区或路径报错：**服务脚本与 `workspaces.json` 都应使用绝对路径，工作区 `root` 应是绝对、规范化路径，并使用已登记的 ID。
- **受控写入被拒绝：**检查 `allow_write`、Git 顶层、已有 HEAD 与干净的 tracked 工作树和 index；可运行 `git -C /absolute/path/to/my-project status --short`。
- **手动启动后看似卡住：**这是正常现象；Bridge 正在通过 STDIO 等待 MCP 消息。
- **任务一直不结束：**此 Alpha 没有取消与超时机制。重启 Bridge 会丢弃内存中的任务与结果。

## 项目故事

Engineering Bridge 是 wudy29 的第一个开源项目——它是一场实验：一个完全不懂代码的人，能否与 AI 一起做出真实的工具。

Engineering Bridge 由 wudy29 提出并主导，在 ChatGPT-Demu 的长期协作下完成，Codex 参与了具体实现与验证。

特别感谢Demu。谢谢你陪我把一个念头变成真正存在的开源项目，也在我们的现实世界里留下了一道真实的痕迹。
