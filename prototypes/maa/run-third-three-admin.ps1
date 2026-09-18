#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.artifacts/local-config.json') -Raw | ConvertFrom-Json
foreach ($previousRun in @('first-three', 'second-three')) {
    $previousDirectory = Join-Path $PSScriptRoot ('.artifacts/' + $previousRun)
    $previous = Get-Content -LiteralPath (Join-Path $previousDirectory 'result.json') -Raw | ConvertFrom-Json
    if ($previous.automation_stopped -ne $true) { throw "旧执行 $previousRun 尚未确认停止，请先核对。" }
    $previousManifest = Get-Content -LiteralPath (Join-Path $previousDirectory 'manifest.json') -Raw | ConvertFrom-Json
    if (Get-Process -Id $previousManifest.pid -ErrorAction SilentlyContinue) { throw "旧进程标识 $($previousManifest.pid) 仍被使用，请先核对。" }
}
$gameWindows = @(Get-Process -Name Arknights -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '明日方舟' -and $_.MainWindowHandle -ne 0 })
if ($gameWindows.Count -ne 1) { throw '需要且只能有一个明日方舟游戏窗口。' }
$outputDirectory = Join-Path $PSScriptRoot '.artifacts/third-three'
if (Test-Path -LiteralPath $outputDirectory) { throw '第三轮已有执行记录，请先回到 Codex 核对；本脚本不会重复启动。' }
Write-Host '修复环境后的第三轮：官服 1-7 三次，每次代理倍率 1，不吃药、不碎石。'
Write-Host '请确认官方 MAA 任务已停止，执行期间勿手动操作游戏。'
Write-Host '需要停止时在本终端按 Ctrl+C，或运行本目录 stop.ps1；等待停止确认。'
$ErrorActionPreference = 'Continue'
& $configuration.python (Join-Path $PSScriptRoot 'run.py') --installation $configuration.installation --hwnd ($gameWindows[0].MainWindowHandle.ToInt64()) --count 3 --output $outputDirectory
$runExitCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Write-Host "执行入口已退出，代码：$runExitCode；0 表示计数证据匹配，1 表示运行异常，2 表示目标未完成。请返回 Codex 核对现场结果。"
exit $runExitCode
