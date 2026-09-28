# Dot-sourced by start.ps1. Configuration discovery is read-only until Save is clicked.
function Invoke-Discovery($python, $file, $adb) {
    if (!(Test-Path -LiteralPath $python -PathType Leaf)) { throw '未找到工程 Python，请在高级设置中选择 Python 解释器后重新检测。' }
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=$python; $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $start.Arguments='"'+(Join-Path $PSScriptRoot 'discovery.py')+'" --config "'+$file+'"'
    if ($adb) { $start.Arguments+=' --adb "'+$adb+'"' }
    $probe=New-Object Diagnostics.Process; $probe.StartInfo=$start
    try {
        $probe.Start() | Out-Null
        $output=$probe.StandardOutput.ReadToEndAsync(); $errors=$probe.StandardError.ReadToEndAsync()
        if (!$probe.WaitForExit(15000)) { $probe.Kill(); throw '自动检测超时，请重新检测或使用高级设置。' }
        if ($probe.ExitCode -ne 0) { throw ('自动检测失败：'+$errors.Result) }
        return $output.Result | ConvertFrom-Json
    } finally { $probe.Dispose() }
}
function Resolve-SettingPath($file, $value) {
    if ([IO.Path]::IsPathRooted($value)) { return [IO.Path]::GetFullPath($value) }
    return [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($file)) $value))
}
function Configure($file) {
    $dialog=New-Object Windows.Forms.Form
    $dialog.Text='ChatMAA 配置'; $dialog.ClientSize=New-Object Drawing.Size(720,470); $dialog.StartPosition='CenterScreen'
    $raw=@{mode='maa-live';dataDir=(Join-Path $root '.artifacts/live')}
    if (Test-Path -LiteralPath $file) {
        $saved=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        foreach ($property in $saved.PSObject.Properties) { $raw[$property.Name]=$property.Value }
        if ($raw.mode -ne 'maa-live') { throw '配置窗口仅用于 MuMu 真实环境；回放配置请通过开发入口维护。' }
    }
    $labels=@('Python 路径','MAA 安装目录','ADB 程序路径','ADB 实例地址','模型 Base URL','模型名称','模型 API Key')
    $defaults=@((Join-Path $root 'adapter/maa/.venv/Scripts/python.exe'),'','','','','','')
    if ($runtimes -and $runtimes.python) { $defaults[0]=$runtimes.python }
    if ($raw.python) { $defaults[0]=(Resolve-SettingPath $file $raw.python) }
    if ($raw.installation) { $defaults[1]=(Resolve-SettingPath $file $raw.installation) }
    if ($raw.connection) { $defaults[2]=(Resolve-SettingPath $file $raw.connection.adb); $defaults[3]=$raw.connection.address }
    $envFile=Join-Path $root '.env'
    if (Test-Path -LiteralPath $envFile) {
        $content=[IO.File]::ReadAllText($envFile)
        $keys=@('CHATMAA_MODEL_BASE_URL','CHATMAA_MODEL_ID','CHATMAA_MODEL_API_KEY')
        for ($i=0;$i -lt 3;$i++) { $match=[regex]::Match($content,'(?m)^\s*'+$keys[$i]+'\s*=(.*)$'); if ($match.Success) { $defaults[$i+4]=$match.Groups[1].Value.Trim().Trim('"').Trim("'") } }
    }
    $intro=New-Object Windows.Forms.Label; $intro.Text='请先启动 MuMu。自动读取本机安装和实例配置，不连接或操作游戏。'; $intro.SetBounds(18,14,680,25); $dialog.Controls.Add($intro)
    $instanceLabel=New-Object Windows.Forms.Label; $instanceLabel.Text='MuMu 实例'; $instanceLabel.SetBounds(18,55,150,25); $dialog.Controls.Add($instanceLabel)
    $instances=New-Object Windows.Forms.ComboBox; $instances.DropDownStyle='DropDownList'; $instances.DisplayMember='label'; $instances.SetBounds(175,50,380,28); $dialog.Controls.Add($instances)
    $refresh=New-Object Windows.Forms.Button; $refresh.Text='重新检测'; $refresh.SetBounds(570,48,125,30); $dialog.Controls.Add($refresh)
    $status=New-Object Windows.Forms.Label; $status.Text='正在检测…'; $status.SetBounds(18,88,680,50); $dialog.Controls.Add($status)
    $boxes=@(); $advancedControls=@()
    $positions=@(470,145,510,550,190,235,280)
    for ($i=0;$i -lt $labels.Count;$i++) {
        $label=New-Object Windows.Forms.Label; $label.Text=$labels[$i]; $label.SetBounds(18,$positions[$i]+4,155,25); $dialog.Controls.Add($label)
        $box=New-Object Windows.Forms.TextBox; $box.Text=$defaults[$i]; $box.SetBounds(175,$positions[$i],380,27); if ($i -eq 6) { $box.UseSystemPasswordChar=$true }; $dialog.Controls.Add($box); $boxes += $box
        if ($i -in @(0,2,3)) { $label.Visible=$false; $box.Visible=$false; $advancedControls += @($label,$box) }
        if ($i -in @(0,1,2)) {
            $browse=New-Object Windows.Forms.Button; $browse.Text='浏览…'; $browse.Tag=$i; $browse.SetBounds(570,$positions[$i]-2,125,30); $dialog.Controls.Add($browse)
            $browse.Add_Click({
                $index=[int]$this.Tag
                if ($index -eq 1) { $picker=New-Object Windows.Forms.FolderBrowserDialog; $picker.Description='选择包含 MaaCore.dll 的 MAA 安装目录' }
                else { $picker=New-Object Windows.Forms.OpenFileDialog; $picker.Filter='程序 (*.exe)|*.exe'; $picker.Title=$labels[$index] }
                try { if ($picker.ShowDialog() -eq 'OK') { $boxes[$index].Text=if ($index -eq 1) { $picker.SelectedPath } else { $picker.FileName }; if ($index -eq 2) { $refresh.PerformClick() } } } finally { $picker.Dispose() }
            })
            if ($i -in @(0,2)) { $browse.Visible=$false; $advancedControls += $browse }
        }
    }
    $advanced=New-Object Windows.Forms.CheckBox; $advanced.Text='高级设置（自动检测失败时手动填写）'; $advanced.SetBounds(18,330,500,28); $dialog.Controls.Add($advanced)
    $advanced.Add_CheckedChanged({ foreach ($control in $advancedControls) { $control.Visible=$advanced.Checked }; $dialog.ClientSize=New-Object Drawing.Size(720, $(if ($advanced.Checked) {610} else {470})) })
    $save=New-Object Windows.Forms.Button; $save.Text='保存配置'; $save.SetBounds(535,380,160,38); $dialog.Controls.Add($save)
    $hint=New-Object Windows.Forms.Label; $hint.Text='配置只保存在本机，后续启动自动复用；不会自动提交游戏任务。'; $hint.SetBounds(18,425,680,30); $dialog.Controls.Add($hint)
    $instances.Add_SelectedIndexChanged({
        if ($instances.SelectedItem) { $boxes[2].Text=$instances.SelectedItem.adb; $boxes[3].Text=$instances.SelectedItem.address }
    })
    $refresh.Add_Click({
        $refresh.Enabled=$false; $status.Text='正在读取 MuMu 配置…'; $dialog.Refresh()
        try {
            $found=Invoke-Discovery $boxes[0].Text.Trim() $file $boxes[2].Text.Trim()
            if (!$boxes[1].Text.Trim() -and @($found.installations).Count -eq 1) { $boxes[1].Text=$found.installations[0] }
            $previousAdb=$boxes[2].Text; $previousAddress=$boxes[3].Text
            $instances.Items.Clear()
            foreach ($candidate in $found.instances) {
                $label=$candidate.name+' — '+$candidate.address
                # Keep installation identity visible when two installations expose the same instance name.
                if (@($found.instances | Where-Object { $_.name -eq $candidate.name }).Count -gt 1) { $label+=' ('+$candidate.adb+')' }
                $item=[PSCustomObject]@{label=$label;adb=$candidate.adb;address=$candidate.address}
                $instances.Items.Add($item) | Out-Null
            }
            if ($instances.Items.Count -eq 1) { $instances.SelectedIndex=0 }
            else { for ($i=0;$i -lt $instances.Items.Count;$i++) { $item=$instances.Items[$i]; if ($item.adb -eq $previousAdb -and $item.address -eq $previousAddress) { $instances.SelectedIndex=$i } } }
            if (!$instances.Items.Count) { $status.Text='未发现实例。请启动 MuMu 后重新检测，或在高级设置中选择 ADB 程序再检测。'; $advanced.Checked=$true }
            elseif ($instances.SelectedIndex -lt 0) { $boxes[2].Clear(); $boxes[3].Clear(); $status.Text='发现多个实例，请选择本次使用的实例。ADB 路径和地址会自动填入。' }
            else { $status.Text='已读取实例配置，ADB 路径和地址已自动填入。连接可用性会在正式运行时核对。' }
        } catch { $status.Text=$_.Exception.Message; $advanced.Checked=$true }
        finally { $refresh.Enabled=$true }
    })
    $save.Add_Click({
        try {
            foreach ($box in $boxes) { if (!$box.Text.Trim()) { throw '配置尚不完整，请选择实例并填写模型和 MAA 安装信息；可在高级设置中检查缺项。' } }
            foreach ($index in @(0,2)) { if (!(Test-Path -LiteralPath $boxes[$index].Text.Trim() -PathType Leaf)) { throw ('程序不存在：'+$labels[$index]) } }
            if ([IO.Path]::GetFileName($boxes[2].Text.Trim()) -notin @('adb.exe','adb_server.exe')) { throw '请选择 adb.exe 或 adb_server.exe，不能选择 MuMuPlayer.exe。' }
            if (!(Test-Path -LiteralPath (Join-Path $boxes[1].Text.Trim() 'MaaCore.dll'))) { throw 'MAA 目录中没有 MaaCore.dll。' }
            if ($boxes[3].Text.Trim() -notmatch '^127\.0\.0\.1:(\d{1,5})$' -or [int]$Matches[1] -lt 1 -or [int]$Matches[1] -gt 65535) { throw 'ADB 地址需要有效的本机端口。' }
            $uri=$null
            if (![Uri]::TryCreate($boxes[4].Text.Trim(),[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -match '/responses/?$') { throw 'Base URL 应为 HTTP(S) API 前缀，不含凭据、查询参数或 /responses。' }
            $modelKeys=@('CHATMAA_MODEL_BASE_URL','CHATMAA_MODEL_ID','CHATMAA_MODEL_API_KEY')
            $lines=@(); if (Test-Path -LiteralPath $envFile) { $lines=@([IO.File]::ReadAllLines($envFile) | Where-Object { $_ -notmatch '^\s*(?:export\s+)?CHATMAA_MODEL_(BASE_URL|ID|API_KEY)\s*=' }) }
            for ($j=0;$j -lt 3;$j++) { $v=$boxes[$j+4].Text.Trim(); if ($v.Contains("'") -or $v.Contains("`n")) { throw '模型配置不能含单引号或换行。' }; $lines+=($modelKeys[$j]+"='"+$v+"'") }
            $pythonCheck=Test-ChatRuntime $boxes[0].Text.Trim() 'python'
            if (!$pythonCheck.valid) { throw $pythonCheck.detail }
            $raw.python=$boxes[0].Text.Trim(); $raw.installation=$boxes[1].Text.Trim(); $raw.Remove('hwnd')
            $raw.connection=@{kind='mumu';adb=$boxes[2].Text.Trim();address=$boxes[3].Text.Trim();config='MuMuEmulator12'}
            [IO.File]::WriteAllLines($envFile,[string[]]$lines,$utf8); Save-Json $file $raw; Save-ChatRuntimes ([PSCustomObject]@{node=$runtimes.node;python=$raw.python}) $file
            $dialog.DialogResult='OK'; $dialog.Close()
        } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'配置未保存') | Out-Null }
    })
    $dialog.Add_Shown({ $refresh.PerformClick() })
    try { return $dialog.ShowDialog() -eq 'OK' } finally { $dialog.Dispose() }
}
