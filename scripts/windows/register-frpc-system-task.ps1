# Optional: run the hidden frpc wrapper at boot as SYSTEM.
# Requires an elevated PowerShell. This keeps the tunnel up before login, but
# DSH Web still requires a logged-in desktop session.
[CmdletBinding()]
param(
    [string]$Root = "C:\dsh-relay",
    [string]$TaskName = "dsh-frpc"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    throw "Run this in an elevated PowerShell (Run as Administrator)."
}

$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
$vbs = Join-Path $Root "start-frpc-hidden.vbs"
foreach ($path in @($vbs, (Join-Path $Root "frpc.exe"), (Join-Path $Root "frpc.toml"))) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing required file: $path"
    }
}

$action = New-ScheduledTaskAction `
    -Execute $wscript `
    -Argument "//B //Nologo `"$vbs`"" `
    -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Registered $TaskName as SYSTEM at startup (hidden frpc)."
Write-Host "DSH Web still needs the user's desktop session; see references/windows.md."
