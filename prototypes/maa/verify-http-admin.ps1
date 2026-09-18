#Requires -RunAsAdministrator
param([switch]$ExecuteApprovedExperiment)
$ErrorActionPreference = 'Stop'
if (-not $ExecuteApprovedExperiment) { throw '先与 Codex 确认这轮范围，再使用 -ExecuteApprovedExperiment；不会自动追加游戏操作。' }
$env:PYTHONUTF8 = '1'
$configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.artifacts/local-config.json') -Raw | ConvertFrom-Json
$lifecycle = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../lifecycle')).Path
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $lifecycle '.venv/Scripts/python.exe'))) { throw 'HTTP 原型依赖缺失，请返回 Codex。' }
foreach ($name in @('verified-three', 'remaining-two')) {
    $previousDirectory = Join-Path $PSScriptRoot ('.artifacts/' + $name)
    $result = Get-Content -LiteralPath (Join-Path $previousDirectory 'result.json') -Raw | ConvertFrom-Json
    $manifest = Get-Content -LiteralPath (Join-Path $previousDirectory 'manifest.json') -Raw | ConvertFrom-Json
    if ($result.automation_stopped -ne $true -or (Get-Process -Id $manifest.pid -ErrorAction SilentlyContinue)) { throw '旧执行尚需核对，请返回 Codex。' }
}
$windows = @(Get-Process -Name Arknights -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '明日方舟' -and $_.MainWindowHandle -ne 0 })
if ($windows.Count -ne 1) { throw '需要且只能有一个明日方舟游戏窗口。' }
$probe = Join-Path $PSScriptRoot '.artifacts/http-merge-home'
$nativeOutput = Join-Path $PSScriptRoot '.artifacts/http-merge-first'
$controller = Join-Path $lifecycle '.artifacts/http-merge-first'
foreach ($path in @($probe, $nativeOutput, $controller)) {
    if (Test-Path -LiteralPath $path) { throw '本轮已有记录，禁止重复运行；返回 Codex 核对。' }
}
New-Item -ItemType Directory -Path $controller | Out-Null
$grantPath = Join-Path $controller 'grant.json'
$grant = @{
    kind = 'manual_http_experiment'; id = 'http-merge-first'; data = (Join-Path $controller 'data')
    installation = $configuration.installation; hwnd = $windows[0].MainWindowHandle.ToInt64()
    output = 'http-merge-first'; stop_after_started_cycles = 2
    params = @{ stage = '1-7'; count = 2; medicine = 0; premium = 0 }
}
[System.IO.File]::WriteAllText($grantPath, ($grant | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Host '阶段 1：请保持游戏主界面，官方 MAA 任务已停止。先检查主界面识别。'
$ErrorActionPreference = 'Continue'
& $configuration.python (Join-Path $PSScriptRoot 'recognize_home.py') --installation $configuration.installation --hwnd $grant.hwnd --output $probe
$probeCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($probeCode -ne 0) { throw '识别未通过，没有启动战斗；返回 Codex 即可。' }
$probeResult = Get-Content -LiteralPath (Join-Path $probe 'result.json') -Raw | ConvertFrom-Json
if ($probeResult.home_recognized -ne $true -or $probeResult.automation_stopped -ne $true) { throw '探针尚未通过或未停止，请返回 Codex。' }
Write-Host '阶段 2：最多开战两次。首局正常完成，第二局开战后通过 HTTP 请求停止；不吃药、不碎石。'
Write-Host '看到自动化停止确认后，第二局可能仍在游戏中进行，需要你自行等待和处理结算。提前停止可按 Ctrl+C。'
Push-Location $lifecycle
try {
    $ErrorActionPreference = 'Continue'
    & $node 'experiments/live-merge.ts' --live --grant $grantPath
    $runCode = $LASTEXITCODE
} finally { Pop-Location }
Write-Host "本轮结束，退出码 $runCode。返回 Codex 核对即可，日志自动保存。"
exit $runCode
