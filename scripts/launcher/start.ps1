param([string]$SessionDirectory, [string]$Config, [switch]$NoModel, [switch]$SmokeTest, [switch]$ConfigureOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$utf8 = New-Object Text.UTF8Encoding($false)
function Save-Json($path, $value) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null; [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 12), $utf8) }
. (Join-Path $PSScriptRoot 'configure.ps1')
. (Join-Path $PSScriptRoot 'runtime.ps1')
try {
    if (!$Config) { $Config=Join-Path $root '.artifacts/mvp/config.json' }
    $Config=[IO.Path]::GetFullPath($Config)
    $runtimes=Resolve-ChatRuntimes $Config -ShowSettings:$ConfigureOnly -NonInteractive:$SmokeTest
    if (!$runtimes) { exit 0 }
    $node=$runtimes.node
    if ($ConfigureOnly) { Configure $Config | Out-Null; exit 0 }
    if ($SmokeTest -and (!$NoModel -or ((Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json).mode -ne 'maa-replay'))) { throw 'SmokeTest 只允许明确的无模型回放配置。' }
    if (!(Test-Path -LiteralPath $Config)) { if (!(Configure $Config)) { exit 0 } }
    if (!$SessionDirectory) { $SessionDirectory=Join-Path $root ('.artifacts/launcher/run-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff')) }
    $SessionDirectory=[IO.Path]::GetFullPath($SessionDirectory)
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$node; $info.WorkingDirectory=$root; $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardInput=$true
    $info.Arguments='"'+(Join-Path $root 'backend/src/launcher.ts')+'" --config "'+$Config+'" --session "'+$SessionDirectory+'"'
    if ($NoModel) { $info.Arguments+=' --no-model' }
    $process=New-Object Diagnostics.Process; $process.StartInfo=$info
    $form=New-Object Windows.Forms.Form; $form.Text='ChatMAA MVP'; $form.ClientSize=New-Object Drawing.Size(600,220); $form.StartPosition='CenterScreen'
    $label=New-Object Windows.Forms.Label; $label.SetBounds(20,20,560,115); $label.Text='正在启动…'; $form.Controls.Add($label)
    $open=New-Object Windows.Forms.Button; $open.Text='打开网页'; $open.SetBounds(20,155,150,40); $open.Enabled=$false; $form.Controls.Add($open)
    $stop=New-Object Windows.Forms.Button; $stop.Text='停止并退出'; $stop.SetBounds(190,155,150,40); $form.Controls.Add($stop)
    $logs=New-Object Windows.Forms.Button; $logs.Text='查看记录'; $logs.SetBounds(360,155,150,40); $form.Controls.Add($logs)
    $script:state=$null; $script:opened=$false
    $open.Add_Click({ if ($script:state.url -match '^http://127\.0\.0\.1:\d+/#token=[\w-]+$') { Start-Process $script:state.url } })
    $logs.Add_Click({ Start-Process explorer.exe -ArgumentList ('"'+$SessionDirectory+'"') })
    $stop.Add_Click({ if (!$process.HasExited) { $process.StandardInput.WriteLine('stop'); $label.Text='正在请求停止并等待证据交接…' } else { $form.Close() } })
    $form.Add_FormClosing({ if (!$process.HasExited) { $_.Cancel=$true; $process.StandardInput.WriteLine('stop'); $label.Text='正在停止，请等待交接完成后再关闭窗口。' } })
    $timer=New-Object Windows.Forms.Timer; $timer.Interval=500
    $timer.Add_Tick({
        try {
            $script:state=[IO.File]::ReadAllText((Join-Path $SessionDirectory 'session.json')) | ConvertFrom-Json
            switch ($script:state.status) {
                'ready' { $label.Text="ChatMAA 已启动（$($script:state.mode)）。`n关闭网页不会停止服务。`n$($script:state.message)"; $open.Enabled=$true; if (!$script:opened) { $script:opened=$true; if ($SmokeTest) { $process.StandardInput.WriteLine('stop') } else { $open.PerformClick() } } }
                'stopping' { $label.Text='正在停止并保存执行证据，请稍候…' }
                'completed' { $label.Text='已完成证据交接，执行端已退出。请核对游戏现场。'; $stop.Text='关闭窗口'; $open.Enabled=$false }
                'failed' { $label.Text="启动或退出未完成：$($script:state.message)`n请查看记录；保留当前数据并核对现场。"; $open.Enabled=$false; if ($process.HasExited) { $stop.Text='关闭窗口' } }
            }
                if ($SmokeTest -and $process.HasExited) { $form.Close() }
        } catch { if ($process.HasExited) { $label.Text='启动器意外退出，请查看记录。'; $stop.Text='关闭窗口' } }
    })
    $process.Start() | Out-Null; $timer.Start(); $form.ShowDialog() | Out-Null; $timer.Stop(); $process.Dispose()
} catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'ChatMAA 启动失败') | Out-Null; exit 1 }
