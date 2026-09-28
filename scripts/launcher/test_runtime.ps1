param([string]$NodePath,[string]$PythonPath)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$root=Join-Path $repo ('.artifacts/checks/runtime-selection-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $root | Out-Null
Copy-Item (Join-Path $repo '.node-version') $root
Copy-Item (Join-Path $repo '.python-version') $root
$utf8=New-Object Text.UTF8Encoding($false)
function Save-Json($path,$value) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null; [IO.File]::WriteAllText($path,($value | ConvertTo-Json -Depth 12),$utf8) }
. (Join-Path $repo 'scripts/launcher/configure.ps1')
. (Join-Path $repo 'scripts/launcher/runtime.ps1')
$configFile=Join-Path $root 'config.json'
Save-Json $configFile @{mode='maa-replay';dataDir=$root;python=$PythonPath}
Save-Json (Join-Path $root '.artifacts/mvp/runtime.json') @{node=$NodePath;python=$PythonPath}
$oldPath=$env:PATH
try {
    $env:PATH=Join-Path $root 'empty-path'
    $selected=Resolve-ChatRuntimes $configFile -NonInteractive
    if ($selected.node -ne $NodePath -or $selected.python -ne $PythonPath) { throw '已保存路径未被复用' }
    if ((Test-ChatRuntime (Join-Path $root 'missing.exe') 'node').valid) { throw '不存在的程序被接受' }
    [IO.File]::WriteAllText((Join-Path $root '.node-version'),'0.0.0')
    $mismatch=Test-ChatRuntime $NodePath 'node'
    if ($mismatch.valid -or $mismatch.detail -notmatch '需要 0.0.0') { throw '版本不符未被拒绝' }
    $rejected=$false
    try { Resolve-ChatRuntimes $configFile -NonInteractive | Out-Null } catch { $rejected=$true }
    if (!$rejected) { throw '没有合格候选时仍然继续' }
    Copy-Item (Join-Path $repo '.node-version') $root -Force
    # Pure candidate-selection fixture: a stale saved path must fall back to the project runtime.
    Save-Json (Join-Path $root '.artifacts/mvp/runtime.json') @{node='C:\missing\node.exe';python=$PythonPath}
    function Test-ChatRuntime($path,$kind) { return [PSCustomObject]@{path=$path;kind=$kind;valid=($kind -eq 'python' -or $path -eq (Join-Path $root '.artifacts/runtimes/node/node.exe'));detail='fixture'} }
    $found=Find-ChatRuntimes $configFile
    if ($found.node -ne (Join-Path $root '.artifacts/runtimes/node/node.exe')) { throw '失效路径未回退到项目运行时' }
    if ($found.checks[0].valid) { throw '失效路径未保留诊断' }
} finally { $env:PATH=$oldPath }
Write-Output '运行环境选择检查通过：保存路径、无 PATH、版本不符、缺失程序、候选回退。'
