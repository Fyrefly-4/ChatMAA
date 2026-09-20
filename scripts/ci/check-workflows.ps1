#requires -Version 7.0
[CmdletBinding()]
param([string]$ActionlintPath)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if (!$ActionlintPath) {
    $toolDir = Join-Path ([IO.Path]::GetTempPath()) ('chatmaa-actionlint-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $toolDir | Out-Null
    $archivePath = Join-Path $toolDir 'actionlint.zip'
    Invoke-WebRequest 'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_windows_amd64.zip' -OutFile $archivePath
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9') {
        throw 'actionlint 安装包 SHA-256 不匹配'
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $toolDir
    $ActionlintPath = Join-Path $toolDir 'actionlint.exe'
}
& $ActionlintPath -version
& $ActionlintPath -shellcheck='' -pyflakes=''
