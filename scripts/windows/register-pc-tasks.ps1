# Register hidden per-user tasks for frpc and DSH Web.
# Both start at this user's logon; no admin required.
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("pc-a", "pc-b")]
    [string]$PcName,

    [string]$Root = "C:\dsh-relay"
)

$ErrorActionPreference = "Stop"
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$cmdExe = Join-Path $env:SystemRoot "System32\cmd.exe"
$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
$vbs = Join-Path $Root "start-frpc-hidden.vbs"
$run = Join-Path $Root "run-dsh-web.cmd"

foreach ($path in @($vbs, $run, (Join-Path $Root "frpc.exe"), (Join-Path $Root "frpc.toml"))) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing required file: $path"
    }
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$frpcAction = New-ScheduledTaskAction `
    -Execute $wscript `
    -Argument "//B //Nologo `"$vbs`"" `
    -WorkingDirectory $Root
$frpcTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$frpcPrincipal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

$webAction = New-ScheduledTaskAction `
    -Execute $cmdExe `
    -Argument "/c `"$run`"" `
    -WorkingDirectory $env:USERPROFILE
$webTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$webPrincipal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

foreach ($task in @("dsh-frpc", "dsh-web-$PcName")) {
    $existing = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    }
}
Start-Sleep -Seconds 2

Register-ScheduledTask -TaskName "dsh-frpc" -Action $frpcAction -Trigger $frpcTrigger `
    -Principal $frpcPrincipal -Settings $settings -Force | Out-Null
Register-ScheduledTask -TaskName "dsh-web-$PcName" -Action $webAction -Trigger $webTrigger `
    -Principal $webPrincipal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName "dsh-frpc"
Start-ScheduledTask -TaskName "dsh-web-$PcName"

Write-Host "Registered and started: dsh-frpc, dsh-web-$PcName (user: $user)"
Write-Host "Check: Get-ScheduledTask -TaskName dsh-frpc,dsh-web-$PcName | Get-ScheduledTaskInfo"
Write-Host "frpc is hidden: Get-Process frpc | Select Id,MainWindowHandle"
Write-Host "These tasks start at logon. If nobody logs in after reboot, DSH stays down."
