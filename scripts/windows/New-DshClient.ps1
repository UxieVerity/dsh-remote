# Render a PC's frpc.toml and start/run scripts from the repo templates.
# No admin required.
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("pc-a", "pc-b")]
    [string]$PcName,

    [Parameter(Mandatory)]
    [string]$BaseDomain,

    [Parameter(Mandatory)]
    [string]$ServerIp,

    [Parameter(Mandatory)]
    [string]$FrpToken,

    [int]$RemotePort = 0,

    [string]$Root = "C:\dsh-relay"
)

$ErrorActionPreference = "Stop"

if ($RemotePort -eq 0) {
    $RemotePort = if ($PcName -eq "pc-a") { 13080 } else { 13081 }
}
if ($RemotePort -lt 13080 -or $RemotePort -gt 13099) {
    throw "RemotePort must be between 13080 and 13099"
}
if ($FrpToken.Length -lt 32) {
    throw "FrpToken must be at least 32 characters (64 hex recommended)"
}
if ($FrpToken -match '"') {
    throw "FrpToken must not contain a double quote"
}
if ($BaseDomain -notmatch '^[A-Za-z0-9.-]+$' -or $BaseDomain.StartsWith('.') -or $BaseDomain.EndsWith('.')) {
    throw "BaseDomain must be a bare domain suffix such as example.com"
}
if ($ServerIp -notmatch '^[A-Za-z0-9.:-]+$') {
    throw "ServerIp must be a hostname or IP literal"
}

$templateRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\templates")).Path
$windowsScripts = $PSScriptRoot
$frpcTemplate = Join-Path $templateRoot "frpc.toml.template"
$webTemplate = Join-Path $windowsScripts "start-dsh-web.cmd.template"

foreach ($path in @($frpcTemplate, $webTemplate)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Template not found: $path"
    }
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null

$frpc = (Get-Content -LiteralPath $frpcTemplate -Raw)
$frpc = $frpc.Replace("__SERVER_IP__", $ServerIp)
$frpc = $frpc.Replace("__FRP_TOKEN__", $FrpToken)
$frpc = $frpc.Replace("__PC_NAME__", $PcName)
$frpc = $frpc.Replace("__REMOTE_PORT__", [string]$RemotePort)
$frpc = $frpc.Replace("__FRPC_LOG__", (($Root -replace '\\', '/') + "/frpc.log"))
[IO.File]::WriteAllText((Join-Path $Root "frpc.toml"), $frpc, [Text.UTF8Encoding]::new($false))

$web = (Get-Content -LiteralPath $webTemplate -Raw)
$web = $web.Replace("__PC_NAME__", $PcName)
$web = $web.Replace("__BASE_DOMAIN__", $BaseDomain)
[IO.File]::WriteAllText((Join-Path $Root "start-dsh-web.cmd"), $web, [Text.UTF8Encoding]::new($false))

Copy-Item -LiteralPath (Join-Path $windowsScripts "run-dsh-web.cmd") -Destination (Join-Path $Root "run-dsh-web.cmd") -Force
Copy-Item -LiteralPath (Join-Path $windowsScripts "start-frpc-hidden.vbs") -Destination (Join-Path $Root "start-frpc-hidden.vbs") -Force
Copy-Item -LiteralPath (Join-Path $windowsScripts "register-pc-tasks.ps1") -Destination (Join-Path $Root "register-pc-tasks.ps1") -Force
Copy-Item -LiteralPath (Join-Path $windowsScripts "register-frpc-system-task.ps1") -Destination (Join-Path $Root "register-frpc-system-task.ps1") -Force

Write-Host "Rendered into $Root"
Write-Host "  frpc.toml"
Write-Host "  start-dsh-web.cmd"
Write-Host "  run-dsh-web.cmd"
Write-Host "  start-frpc-hidden.vbs"
Write-Host "  register-pc-tasks.ps1"
Write-Host "  register-frpc-system-task.ps1"
Write-Host ""
if (-not (Test-Path -LiteralPath (Join-Path $Root "frpc.exe"))) {
    Write-Host "NEXT: place frpc.exe in $Root (matching the server's frp release)." -ForegroundColor Yellow
}
Write-Host "Then test:  $Root\start-dsh-web.cmd"
Write-Host "Then run:   powershell -ExecutionPolicy Bypass -File $Root\register-pc-tasks.ps1 -PcName $PcName"
