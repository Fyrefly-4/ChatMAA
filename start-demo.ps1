#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$Replay,
    [string]$Config,
    [switch]$NoBrowser,
    [switch]$NoModel
)
$ErrorActionPreference = 'Stop'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (!$node) { throw '找不到 Node。请先安装 .node-version 指定的版本，并加入 PATH。' }
$expectedNode = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '.node-version') -Raw).Trim()
$actualNode = & $node.Source -p 'process.versions.node'
if ($actualNode -ne $expectedNode) { throw "Node 版本不符：需要 $expectedNode，当前 $actualNode" }
$demoArguments = @((Join-Path $PSScriptRoot 'backend/src/demo-entry.ts'), '--web', '--demo')
if ($Replay) { $demoArguments += '--replay' }
if ($Config) { $demoArguments += @('--demo-config', [IO.Path]::GetFullPath($Config)) }
if ($NoBrowser) { $demoArguments += '--no-browser' }
if ($NoModel) { $demoArguments += '--no-model' }
& $node.Source @demoArguments
if ($LASTEXITCODE -ne 0) { throw 'Demo 未正常完成启动或退出交接，请查看上方错误；不要直接重开执行。' }
Write-Host 'Backend 已退出。自动化停止不等于游戏战斗结束，请核对现场。'
