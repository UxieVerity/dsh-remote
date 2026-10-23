# Install the DSH remote-login plugin into the web profile.
# Run as the Windows user that owns DSH. No admin required.
[CmdletBinding()]
param(
    [string]$DshCli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd",
    [string]$PluginVersion = "0.1.13",
    [string]$Registry = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $DshCli)) {
    throw "DSH CLI not found: $DshCli"
}

& $DshCli --version
if ($LASTEXITCODE -ne 0) {
    throw "DSH CLI failed to start: $DshCli"
}

$plugin = "dsh-web-startup-auth@$PluginVersion"
$pluginArgs = @("plugin", "--profile", "web", "add", $plugin)
if ($Registry) {
    $pluginArgs += @("--registry", $Registry)
}

Write-Host "Installing $plugin ..."
& $DshCli @pluginArgs
if ($LASTEXITCODE -ne 0) {
    throw "Plugin install failed. If the registry is an internal mirror, retry with -Registry https://registry.npmjs.org/"
}

Write-Host ""
Write-Host "Installed into the web profile. Restart DSH Web for the plugin to load."
Write-Host "Check: & `"$DshCli`" plugin --profile web list"
