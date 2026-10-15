param(
  [Parameter(Mandatory=$true)][ValidateSet('install','start','stop','remove','run','shortcuts','remove-shortcuts')][string]$Action,
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$RootPath,
  [Parameter(Mandatory=$true)][string]$CodexHome,
  [Parameter(Mandatory=$true)][string]$StatePath
)
$ErrorActionPreference = 'Stop'
$taskName = 'CodexWorkBuddySuite'
$daemon = Join-Path $RootPath 'scripts\daemon.mjs'
$manager = Join-Path $RootPath 'scripts\manage.mjs'
# CommandLineToArgvW-compatible quoting. No input is evaluated as PowerShell.
function Quote-Argument([string]$Value) {
  if ($Value.IndexOf([char]0) -ge 0 -or $Value.Contains("`r") -or $Value.Contains("`n")) { throw 'invalid-service-path' }
  return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
$daemonArguments = (Quote-Argument $daemon) + ' --home ' + (Quote-Argument $CodexHome) + ' --state ' + (Quote-Argument $StatePath)
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (Quote-Argument $PSCommandPath) + ' -Action run -NodePath ' + (Quote-Argument $NodePath) + ' -RootPath ' + (Quote-Argument $RootPath) + ' -CodexHome ' + (Quote-Argument $CodexHome) + ' -StatePath ' + (Quote-Argument $StatePath)
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
  $actions = @($task.Actions)
  if ($actions.Count -ne 1 -or $actions[0].Execute -cne $powershell -or $actions[0].Arguments -cne $arguments -or $actions[0].WorkingDirectory -cne $RootPath) { throw 'service-owned-by-another-installation' }
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ($task.Principal.UserId -ne $user -and $task.Principal.UserId -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'service-owned-by-another-user' }
}
switch ($Action) {
  'install' {
    if ($null -eq $task) {
      $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $RootPath
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      $settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
      Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    }
  }
  'start' { if ($null -eq $task) { throw 'service-not-installed' }; Enable-ScheduledTask -TaskName $taskName | Out-Null; Start-ScheduledTask -TaskName $taskName }
  # Disable auto-start first. Runtime exits through its authenticated HTTP API;
  # Stop-ScheduledTask would terminate the daemon and is deliberately avoided.
  'stop' { if ($null -ne $task) { Disable-ScheduledTask -TaskName $taskName | Out-Null } }
  'remove' { if ($null -ne $task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false } }
  'run' {
    $process = Start-Process -FilePath $NodePath -ArgumentList $daemonArguments -WorkingDirectory $RootPath -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $StatePath 'service.stdout.log') -RedirectStandardError (Join-Path $StatePath 'service.stderr.log')
    exit $process.ExitCode
  }
  { $_ -in 'shortcuts','remove-shortcuts' } {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell
    foreach ($entry in @(@('launch','Codex WorkBuddy'),@('usage','WorkBuddy Usage'))) {
      $file = Join-Path $desktop ($entry[1] + '.lnk')
      $args = (Quote-Argument $manager) + ' ' + $entry[0] + ' --home ' + (Quote-Argument $CodexHome) + ' --state ' + (Quote-Argument $StatePath)
      if (Test-Path -LiteralPath $file) {
        $existing = $shell.CreateShortcut($file)
        if ($existing.TargetPath -cne $NodePath -or $existing.Arguments -cne $args) { throw 'shortcut-owned-by-another-installation' }
      }
      if ($Action -eq 'shortcuts') {
        $shortcut = $shell.CreateShortcut($file); $shortcut.TargetPath = $NodePath; $shortcut.Arguments = $args; $shortcut.WorkingDirectory = $RootPath; $shortcut.WindowStyle = 7; $shortcut.Description = 'Codex WorkBuddy Suite'; $shortcut.Save()
      } elseif (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
  }
}
