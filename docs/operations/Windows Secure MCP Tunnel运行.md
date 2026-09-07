# Windows Secure MCP Tunnel 运行

本项目的 Windows Tunnel 启动器是：

```text
scripts/windows/start-tunnel-runtime.ps1
```

它只做启动前环境准备和 managed runtime 健康确认，不修改 Bridge 源码、不自动 build、不打开浏览器，也不创建新的 Tunnel、Runtime key 或 ChatGPT app。

## 为什么不能写死 Codex hash

Codex Desktop 更新后，官方 executable 可能从：

```text
%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
```

切换到新的 hash 目录。启动器每次运行时只在这个官方安装根内查找普通文件 `codex.exe`，执行 `--version`，验证 `codex-cli <version>`，再按以下规则选择：

1. 选择最高的已验证 CLI 版本；
2. 版本相同优先官方根目录 current-pointer；
3. 仍相同才按文件更新时间选择。

不会搜索整个 C 盘、使用第三方 `codex.exe` 或依赖目录名大小比较。

## 一次性保存 Runtime key

Runtime key 不放入脚本、任务参数或仓库。首次配置时运行下面的命令，并在隐藏输入提示中输入 key：

```powershell
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\initialize-tunnel-runtime-secret.ps1
```

脚本保存到：

```text
%LOCALAPPDATA%\EngineeringBridge\secrets\control-plane-api-key
```

它会创建当前用户专用 ACL、写入无换行的单行内容，并只输出路径和安全状态，不输出 key。已有文件不会被覆盖；只有明确轮换时才使用：

```powershell
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\initialize-tunnel-runtime-secret.ps1 -Rotate
```

启动器和 managed runtime 使用 `file:<absolute-path>` 引用该文件。不要把文件内容复制到命令行、任务参数或日志中。

启动器不会自动运行 `npm run build`。它要求以下构建产物已经存在：

```text
dist/src/mcp-stdio.js
var/workspaces.windows.local.json
```

缺失时先手动执行：

```powershell
npm run build
```

然后运行启动器：

```powershell
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\start-tunnel-runtime.ps1
```

启动器会动态解析 Codex、把其父目录只加入当前 PowerShell 进程的 PATH，并使用官方 managed runtime。若 runtime 已健康运行，启动器输出 `ALREADY_RUNNING=YES` 并直接结束，不会重复 connect，也不需要重新读取 secret：

```text
tunnel-client runtimes connect
```

它复用现有 Tunnel ID 和 `bridge-local` alias/profile，MCP command 使用 Node、Bridge STDIO 入口和 Windows workspace config 的绝对路径。

managed runtime 接收的是一个命令字符串；启动器只在该字符串内部把 Windows 路径转换为正斜杠，以避免 `tunnel-client` 的命令解析器把反斜杠误当作转义符。实际文件路径和 Windows 文件系统没有改变。

如果当前网络需要代理，确保当前用户在登录时可获得标准的 `HTTPS_PROXY` 环境配置；managed runtime 会通过子进程继承它。不要把代理或 secret 放进任务参数，也不要把旧的 `--control-plane.http-proxy` 参数拼到 `runtimes connect` 命令中。

## 登录后自动启动

确认 secret 文件已经初始化后，注册当前用户的隐藏任务：

```powershell
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\manage-tunnel-runtime-task.ps1 -Action register
```

任务名为 `Engineering Bridge Secure MCP Tunnel`，触发器是当前用户登录，使用 PowerShell 7、当前用户的交互式受限令牌，不使用 SYSTEM；重复启动采用 `IgnoreNew`，短暂失败最多自动重试 3 次。任务参数只有 launcher 路径，不包含 key、`file:` 引用或 Tunnel ID。

查看、手动触发、停用和移除任务：

```powershell
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\manage-tunnel-runtime-task.ps1 -Action status

pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\manage-tunnel-runtime-task.ps1 -Action run

pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\manage-tunnel-runtime-task.ps1 -Action disable

pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\manage-tunnel-runtime-task.ps1 -Action remove
```

`disable` 和 `remove` 只影响本机任务，不删除 secret、Tunnel 或 ChatGPT app。实际注销/重启后的登录验证需单独记录；在未执行前只能标记为 `PENDING_USER_REBOOT`。

## 状态与停止

启动成功后检查 managed runtime：

```powershell
tunnel-client runtimes status bridge-local --json
```

只有 `process_running=true`、`healthy=true`、`ready=true`，并且 control-plane poll 检查通过，才算启动成功。

停止本次 runtime：

```powershell
tunnel-client runtimes stop bridge-local
```

确认没有残留：

```powershell
Get-Process -Name tunnel-client -ErrorAction SilentlyContinue
```

## PATH 和密钥边界

- Codex 目录只加入启动器当前进程及其 managed runtime 子进程的 PATH。
- 不使用 `setx`、Registry、用户 PATH、系统 PATH 或 PowerShell profile 持久化。
- Runtime key 只通过 `file:<absolute-path>` 引用；实际 key 不进入仓库、脚本、任务参数或 launcher 输出。
- 启动器不接受 arbitrary executable、arbitrary MCP command、arbitrary PATH injection 或 literal key。
- 启动器不会修改 ChatGPT app。

## Targeted tests

运行无第三方依赖的 PowerShell 7 targeted tests：

```powershell
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\test-tunnel-runtime.ps1

pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\test-tunnel-runtime-task.ps1
```

测试覆盖 PATH 缺少 Codex、旧 hash 消失/新候选出现、多个候选、无 Codex、无效版本、secret 文件缺失/换行、健康 runtime 的幂等 no-op、缺少 dist，以及 User/Machine PATH 未被修改；任务测试覆盖当前用户登录、隐藏任务、IgnoreNew、PowerShell 7、路径 quoting 和无 secret 参数。
