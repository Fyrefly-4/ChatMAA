#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$configurationFile = Join-Path $PSScriptRoot '.artifacts/local-config.json'
$configuration = Get-Content -LiteralPath $configurationFile -Raw | ConvertFrom-Json
$gameWindows = @(Get-Process -Name Arknights -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '明日方舟' -and $_.MainWindowHandle -ne 0 })
if ($gameWindows.Count -ne 1) { throw '需要且只能有一个已启动的明日方舟游戏窗口。' }
$outputDirectory = Join-Path $PSScriptRoot ('.artifacts/preflight-admin-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
Write-Host '本脚本只加载 MaaCore、连接指定游戏窗口并保存截图，不提交战斗任务。'
& $configuration.python (Join-Path $PSScriptRoot 'preflight.py') --installation $configuration.installation --hwnd $gameWindows[0].MainWindowHandle.ToInt64() --output $outputDirectory 2>&1 | Tee-Object -FilePath (Join-Path $outputDirectory 'console.log')
$preflightExitCode = $LASTEXITCODE
@{ exit_code = $preflightExitCode; output = $outputDirectory; finished_at = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath (Join-Path $PSScriptRoot '.artifacts/preflight-admin-result.json')
if ($preflightExitCode -ne 0) { throw "连接预检失败。日志已保留：$outputDirectory" }
Write-Host "连接预检完成。日志和截图：$outputDirectory"
Write-Host '请返回 Codex 告知预检已完成。'
