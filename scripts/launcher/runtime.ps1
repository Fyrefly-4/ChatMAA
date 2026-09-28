# Runtime selection runs in PowerShell, before Node is required.
function Test-ChatRuntime($path, $kind) {
    $expected=(Get-Content -LiteralPath (Join-Path $root $(if ($kind -eq 'node') {'.node-version'} else {'.python-version'})) -Raw).Trim()
    $result=[PSCustomObject]@{path=$path;kind=$kind;valid=$false;detail='文件不存在';expected=$expected}
    if (!$path -or !(Test-Path -LiteralPath $path -PathType Leaf)) { return $result }
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$path; $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.Arguments=if ($kind -eq 'node') {'-p "process.versions.node"'} else {'-c "import platform,struct,fastapi,uvicorn; print(platform.python_version()); assert struct.calcsize(''P'')==8"'}
    foreach ($key in @('CHATMAA_MODEL_API_KEY','DEEPSEEK_API_KEY','OPENAI_API_KEY')) { $info.EnvironmentVariables.Remove($key) }
    $probe=New-Object Diagnostics.Process; $probe.StartInfo=$info
    try {
        $probe.Start() | Out-Null; $output=$probe.StandardOutput.ReadToEndAsync(); $errors=$probe.StandardError.ReadToEndAsync()
        if (!$probe.WaitForExit(10000)) { $probe.Kill(); $result.detail='运行检查超时'; return $result }
        $version=$output.Result.Trim()
        if ($probe.ExitCode -ne 0) { $result.detail=if ($kind -eq 'python') {'无法运行、不是 x64 或缺少 fastapi/uvicorn；请按环境准备说明安装依赖。'} else {'程序无法运行'} }
        elseif ($version -ne $expected) { $result.detail="版本 $version，需要 $expected" }
        else { $result.valid=$true; $result.path=[IO.Path]::GetFullPath($path); $result.detail="版本 $version，检查通过" }
    } catch { $result.detail=$_.Exception.Message } finally { $probe.Dispose() }
    return $result
}
function Find-ChatRuntimes($configFile) {
    $saved=$null; $config=$null
    $runtimeFile=Join-Path $root '.artifacts/mvp/runtime.json'
    if (Test-Path -LiteralPath $runtimeFile) { try { $saved=Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json } catch {} }
    if (Test-Path -LiteralPath $configFile) { $config=Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json }
    $nodes=@($saved.node,(Join-Path $root '.artifacts/runtimes/node/node.exe'))
    if ($env:NVM_HOME) { $nodes+=Join-Path $env:NVM_HOME ('v'+(Get-Content (Join-Path $root '.node-version') -Raw).Trim()+'/node.exe') }
    $nodes+=@(Get-Command node.exe -All -CommandType Application -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
    $pythons=@()
    if ($config.python) { $pythons+=Resolve-SettingPath $configFile $config.python }
    $pythons+=@($saved.python,(Join-Path $root 'adapter/maa/.venv/Scripts/python.exe'),(Join-Path $root '.artifacts/runtimes/python/python.exe'))
    $pythons+=@(Get-Command python.exe -All -CommandType Application -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
    $checks=@(); $selected=@{}
    foreach ($kind in @('node','python')) {
        $candidates=if ($kind -eq 'node') {$nodes} else {$pythons}
        foreach ($candidate in @($candidates | Where-Object { $_ -and $_ -notmatch '\\WindowsApps\\' } | Select-Object -Unique)) {
            $check=Test-ChatRuntime $candidate $kind; $checks+=$check
            if ($check.valid) { $selected[$kind]=$check.path; break }
        }
    }
    return [PSCustomObject]@{node=$selected.node;python=$selected.python;checks=$checks}
}
function Save-ChatRuntimes($selected, $configFile) {
    Save-Json (Join-Path $root '.artifacts/mvp/runtime.json') @{node=$selected.node;python=$selected.python}
    if (Test-Path -LiteralPath $configFile) {
        $raw=Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
        $raw | Add-Member -NotePropertyName python -NotePropertyValue $selected.python -Force
        Save-Json $configFile $raw
    }
}
function Resolve-ChatRuntimes($configFile, [switch]$ShowSettings, [switch]$NonInteractive) {
    $found=Find-ChatRuntimes $configFile
    if (!$ShowSettings -and $found.node -and $found.python) { Save-ChatRuntimes $found $configFile; return $found }
    if ($NonInteractive) { throw ('未找到符合版本的运行环境：'+(($found.checks | ForEach-Object { $_.path+'：'+$_.detail }) -join '; ')) }
    $dialog=New-Object Windows.Forms.Form; $dialog.Text='ChatMAA 运行环境'; $dialog.ClientSize=New-Object Drawing.Size(780,410); $dialog.StartPosition='CenterScreen'
    $intro=New-Object Windows.Forms.Label; $intro.Text=('需要 Node '+(Get-Content (Join-Path $root '.node-version') -Raw).Trim()+'、Python '+(Get-Content (Join-Path $root '.python-version') -Raw).Trim()+' x64（含 fastapi/uvicorn）。'+[Environment]::NewLine+'自动检测并保存路径，也可浏览选择已有程序。'); $intro.SetBounds(15,15,750,40); $dialog.Controls.Add($intro)
    $fields=@{}
    foreach ($kind in @('node','python')) {
        $y=if ($kind -eq 'node') {65} else {110}
        $label=New-Object Windows.Forms.Label; $label.Text=$kind; $label.SetBounds(15,$y+4,80,25); $dialog.Controls.Add($label)
        $box=New-Object Windows.Forms.TextBox; $box.Text=$found.$kind; $box.SetBounds(95,$y,520,28); $dialog.Controls.Add($box); $fields[$kind]=$box
        $button=New-Object Windows.Forms.Button; $button.Text='浏览…'; $button.Tag=$kind; $button.SetBounds(630,$y-2,130,30); $dialog.Controls.Add($button)
        $button.Add_Click({ $picker=New-Object Windows.Forms.OpenFileDialog; $picker.Filter='程序 (*.exe)|*.exe'; try { if ($picker.ShowDialog() -eq 'OK') { $fields[$this.Tag].Text=$picker.FileName } } finally { $picker.Dispose() } })
    }
    $details=New-Object Windows.Forms.TextBox; $details.Multiline=$true; $details.ReadOnly=$true; $details.ScrollBars='Vertical'; $details.SetBounds(15,160,745,160); $dialog.Controls.Add($details)
    $details.Text=($found.checks | ForEach-Object { $_.kind+'：'+$_.path+"`r`n"+$_.detail }) -join "`r`n`r`n"
    $refresh=New-Object Windows.Forms.Button; $refresh.Text='重新检测'; $refresh.SetBounds(15,345,130,38); $dialog.Controls.Add($refresh)
    $refresh.Add_Click({ $latest=Find-ChatRuntimes $configFile; foreach ($kind in @('node','python')) { if ($latest.$kind) { $fields[$kind].Text=$latest.$kind } }; $details.Text=($latest.checks | ForEach-Object { $_.path+'：'+$_.detail }) -join "`r`n" })
    $save=New-Object Windows.Forms.Button; $save.Text='保存并继续'; $save.SetBounds(590,345,170,38); $dialog.Controls.Add($save)
    $save.Add_Click({
        $checks=@(Test-ChatRuntime $fields.node.Text.Trim() 'node'; Test-ChatRuntime $fields.python.Text.Trim() 'python')
        $details.Text=($checks | ForEach-Object { $_.path+'：'+$_.detail }) -join "`r`n"
        if (@($checks | Where-Object { !$_.valid }).Count) { return }
        $dialog.Tag=[PSCustomObject]@{node=$checks[0].path;python=$checks[1].path}
        $dialog.DialogResult='OK'; $dialog.Close()
    })
    try { if ($dialog.ShowDialog() -ne 'OK') { return $null }; Save-ChatRuntimes $dialog.Tag $configFile; return $dialog.Tag } finally { $dialog.Dispose() }
}
