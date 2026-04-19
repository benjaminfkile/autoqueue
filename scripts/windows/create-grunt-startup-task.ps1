param(
  [string]$TaskName = "GRUNT",
  [string]$RunAsUser = "$env:USERDOMAIN\$env:USERNAME",
  [string]$ProjectDir,
  [string]$StartupDelay = "PT30S",
  [switch]$IncludeLogonTrigger = $true
)

$ErrorActionPreference = "Stop"

if (-not $PSBoundParameters.ContainsKey("ProjectDir")) {
  $ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

$startupScript = Join-Path $ProjectDir "scripts\windows\start-grunt-api.cmd"
if (-not (Test-Path $startupScript)) {
  throw "Startup script not found: $startupScript"
}

$cred = Get-Credential -UserName $RunAsUser -Message "Enter password for the GRUNT startup task account"
$password = $cred.GetNetworkCredential().Password

# Build task definition with explicit action and robust settings.
$action = New-ScheduledTaskAction -Execute $startupScript -WorkingDirectory $ProjectDir

$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$startupTrigger.Delay = $StartupDelay

$triggers = @($startupTrigger)
if ($IncludeLogonTrigger) {
  $triggers += New-ScheduledTaskTrigger -AtLogOn -User $cred.UserName
}

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$settings.MultipleInstances = "IgnoreNew"
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -User $cred.UserName `
  -Password $password `
  -RunLevel Highest `
  -Force | Out-Null

Write-Host "Task '$TaskName' created and hardened."
Write-Host "Verify with: schtasks /query /tn '$TaskName' /v /fo list"
Write-Host "Run now with: schtasks /run /tn '$TaskName'"
