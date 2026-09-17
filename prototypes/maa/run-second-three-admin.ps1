#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.artifacts/local-config.json') -Raw | ConvertFrom-Json
$previous = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.artifacts/first-three/result.json') -Raw | ConvertFrom-Json
if ($previous.automation_stopped -ne $true) { throw '首轮尚未确认停止，请先回到 Codex 核对。' }
$previousManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.artifacts/first-three/manifest.json') -Raw | ConvertFrom-Json
if (Get-Process -Id $previousManifest.pid -ErrorAction SilentlyContinue) { throw '首轮进程标识仍被使用，请先核对，不启动第二轮。' }
$gameWindows = @(Get-Process -Name Arknights -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '明日方舟' -and $_.MainWindowHandle -ne 0 })
if ($gameWindows.Count -ne 1) { throw '需要且只能有一个明日方舟游戏窗口。' }
$outputDirectory = Join-Path $PSScriptRoot '.artifacts/second-three'
if (Test-Path -LiteralPath $outputDirectory) { throw '第二轮已有执行记录，请先回到 Codex 核对；本脚本不会重复启动。' }
Write-Host '第二轮：请已切换到日间主题并回到游戏主界面。'
Write-Host '执行已授权的官服 1-7 三次，每次代理倍率 1，不吃药、不碎石。'
Write-Host '执行期间请勿手动操作游戏或同时启动其他 MAA 任务。'
Write-Host '需要停止时在本终端按 Ctrl+C，或运行本目录 stop.ps1；等待停止确认。'
$ErrorActionPreference = 'Continue'
& $configuration.python (Join-Path $PSScriptRoot 'run.py') --installation $configuration.installation --hwnd ($gameWindows[0].MainWindowHandle.ToInt64()) --count 3 --output $outputDirectory
$runExitCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Write-Host "执行入口已退出，代码：$runExitCode；0 表示计数证据匹配，1 表示运行异常，2 表示目标未完成。请返回 Codex 核对现场结果。"
exit $runExitCode
