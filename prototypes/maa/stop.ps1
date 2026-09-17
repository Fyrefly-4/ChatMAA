$ErrorActionPreference = 'Stop'
$live = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.artifacts/live-run.json') -Raw | ConvertFrom-Json
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.artifacts'))
$runDirectory = [System.IO.Path]::GetFullPath($live.output)
if (-not $runDirectory.StartsWith($artifactRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw '运行路径不在原型产物目录内。' }
Set-Content -LiteralPath (Join-Path $runDirectory 'stop.request') -Value 'user requested stop' -Encoding utf8
Write-Host '已发出停止请求，请等待执行终端的 automation_not_running 与最终记录。'
