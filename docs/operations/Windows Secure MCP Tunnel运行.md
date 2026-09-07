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

## 启动

先在同一个 PowerShell 7 会话中设置 Runtime API key。启动器只检查 `CONTROL_PLANE_API_KEY` 是否存在，不接受命令行 literal，也不会打印或写入 key：

```powershell
$secure = Read-Host "Runtime key" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:CONTROL_PLANE_API_KEY =
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
```

启动器不会自动运行 `npm run build`。它要求以下构建产物已经存在：

```text
dist/src/mcp-stdio.js
var/workspaces.windows.local.json
```

缺失时先手动执行：

```powershell
npm run build
```

然后运行：

```powershell
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\start-tunnel-runtime.ps1
```

启动器会动态解析 Codex、把其父目录只加入当前 PowerShell 进程的 PATH，并使用官方 managed runtime：

```text
tunnel-client runtimes connect
```

它复用现有 Tunnel ID 和 `bridge-local` alias/profile，MCP command 使用 Node、Bridge STDIO 入口和 Windows workspace config 的绝对路径。

managed runtime 接收的是一个命令字符串；启动器只在该字符串内部把 Windows 路径转换为正斜杠，以避免 `tunnel-client` 的命令解析器把反斜杠误当作转义符。实际文件路径和 Windows 文件系统没有改变。

如果当前网络需要代理，在同一个 PowerShell 7 会话中先设置标准的 `HTTPS_PROXY`，再启动 launcher。managed runtime 通过子进程继承该环境变量；不要把旧的 `--control-plane.http-proxy` 参数拼到 `runtimes connect` 命令中。

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
- Runtime key 继续通过 `env:CONTROL_PLANE_API_KEY` 引用。
- 启动器不接受 arbitrary executable、arbitrary MCP command、arbitrary PATH injection 或 literal key。
- 启动器不会修改 ChatGPT app。

## Targeted tests

运行无第三方依赖的 PowerShell 7 targeted tests：

```powershell
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\windows\test-tunnel-runtime.ps1
```

测试覆盖 PATH 缺少 Codex、旧 hash 消失/新候选出现、多个候选、无 Codex、无效版本、缺少 runtime key、缺少 dist，以及 User/Machine PATH 未被修改。
