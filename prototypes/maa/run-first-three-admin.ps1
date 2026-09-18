#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.artifacts/local-config.json') -Raw | ConvertFrom-Json
$preflight = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.artifacts/preflight-admin-result.json') -Raw | ConvertFrom-Json
if ($preflight.exit_code -ne 0) { throw '请先完成连接预检。' }
$gameWindows = @(Get-Process -Name Arknights -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '明日方舟' -and $_.MainWindowHandle -ne 0 })
if ($gameWindows.Count -ne 1) { throw '需要且只能有一个明日方舟游戏窗口。' }
$outputDirectory = Join-Path $PSScriptRoot '.artifacts/first-three'
if (Test-Path -LiteralPath $outputDirectory) { throw '首轮已有执行记录，请先回到 Codex 核对；本脚本不会重复启动。' }
Write-Host '即将执行已授权的官服 1-7 三次，每次代理倍率 1，不吃药、不碎石。'
Write-Host '执行期间请勿手动操作游戏或同时启动其他 MAA 任务。'
Write-Host '需要停止时在本终端按 Ctrl+C，或运行本目录 stop.ps1；等待停止确认。'
$ErrorActionPreference = 'Continue'
& $configuration.python (Join-Path $PSScriptRoot 'run.py') --installation $configuration.installation --hwnd ($gameWindows[0].MainWindowHandle.ToInt64()) --count 3 --output $outputDirectory
$runExitCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Write-Host "执行入口已退出，代码：$runExitCode；请返回 Codex 核对结果。"
exit $runExitCode
