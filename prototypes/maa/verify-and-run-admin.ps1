#Requires -RunAsAdministrator
param([switch]$Remaining)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.artifacts/local-config.json') -Raw | ConvertFrom-Json
foreach ($previousRun in @('first-three', 'second-three', 'third-three')) {
    $previousDirectory = Join-Path $PSScriptRoot ('.artifacts/' + $previousRun)
    $previous = Get-Content -LiteralPath (Join-Path $previousDirectory 'result.json') -Raw | ConvertFrom-Json
    if ($previous.automation_stopped -ne $true) { throw "旧执行 $previousRun 尚未确认停止。" }
    $previousManifest = Get-Content -LiteralPath (Join-Path $previousDirectory 'manifest.json') -Raw | ConvertFrom-Json
    if (Get-Process -Id $previousManifest.pid -ErrorAction SilentlyContinue) { throw '旧进程标识仍被使用，请回到 Codex 核对。' }
}
$gameWindows = @(Get-Process -Name Arknights -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '明日方舟' -and $_.MainWindowHandle -ne 0 })
if ($gameWindows.Count -ne 1) { throw '需要且只能有一个明日方舟游戏窗口。' }
$desiredCount = 3
$continueArguments = @()
$probeName = 'verified-home'
$runName = 'verified-three'
if ($Remaining) {
    $previousDirectory = Join-Path $PSScriptRoot '.artifacts/verified-three'
    $previous = Get-Content -LiteralPath (Join-Path $previousDirectory 'result-reinterpreted.json') -Raw | ConvertFrom-Json
    $previousManifest = Get-Content -LiteralPath (Join-Path $previousDirectory 'manifest.json') -Raw | ConvertFrom-Json
    if ($previous.automation_stopped -ne $true -or $previous.count_unknown -ne $false -or $previous.observed_successes -ne 1 -or $previous.requested -ne 3) { throw '旧结果不符合已核对的成功一次、剩余两次条件。' }
    if (Get-Process -Id $previousManifest.pid -ErrorAction SilentlyContinue) { throw '旧执行进程标识仍被使用，先核对。' }
    $desiredCount = 2
    $continueArguments = @('--continues', 'verified-three')
    $probeName = 'remaining-home'
    $runName = 'remaining-two'
}
$probeDirectory = Join-Path $PSScriptRoot ('.artifacts/' + $probeName)
$runDirectory = Join-Path $PSScriptRoot ('.artifacts/' + $runName)
if ((Test-Path -LiteralPath $probeDirectory) -or (Test-Path -LiteralPath $runDirectory)) { throw '本轮已有记录，请先核对；不重复启动。' }
Write-Host '阶段 1：请保持游戏主界面，官方 MAA 已停止任务。只识别主界面，不点击按钮、不打关卡。'
$ErrorActionPreference = 'Continue'
& $configuration.python (Join-Path $PSScriptRoot 'recognize_home.py') --installation $configuration.installation --hwnd ($gameWindows[0].MainWindowHandle.ToInt64()) --output $probeDirectory
$probeExitCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($probeExitCode -ne 0) { throw '主界面识别未通过，本轮结束，没有启动战斗。返回 Codex 即可，日志已自动保存。' }
$probeResult = Get-Content -LiteralPath (Join-Path $probeDirectory 'result.json') -Raw | ConvertFrom-Json
if ($probeResult.home_recognized -ne $true) { throw '识别结果不满足门槛，不启动战斗。' }
Write-Host "阶段 2：识别通过，开始官服 1-7 $desiredCount 次，不吃药、不碎石。停止请按 Ctrl+C。"
$ErrorActionPreference = 'Continue'
& $configuration.python (Join-Path $PSScriptRoot 'run.py') --installation $configuration.installation --hwnd ($gameWindows[0].MainWindowHandle.ToInt64()) --count $desiredCount --output $runDirectory @continueArguments
$runExitCode = $LASTEXITCODE
Write-Host "本轮结束，退出码 $runExitCode。请返回 Codex 核对；日志已自动保存，不必手动复制。"
exit $runExitCode
