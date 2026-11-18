param([Parameter(Mandatory=$true)][string]$Launcher)
$ErrorActionPreference = 'Stop'
$resolvedLauncher = (Resolve-Path -LiteralPath $Launcher).Path
if ([IO.Path]::GetExtension($resolvedLauncher) -ne '.vbs') { throw 'Invalid launcher' }
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$taskName = 'YuQuTranscription'
$marker = 'YuQuLibrary transcription service v1'
$existing = $null
try { $existing = $folder.GetTask($taskName) } catch { }
if ($existing -and $existing.Definition.RegistrationInfo.Description -ne $marker) { throw 'Task name belongs to another application' }
$definition = $scheduler.NewTask(0)
$definition.RegistrationInfo.Description = $marker
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition.Principal.UserId = $userId
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$definition.Settings.Enabled = $true
$definition.Settings.Hidden = $true
$definition.Settings.StartWhenAvailable = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.MultipleInstances = 2
$definition.Settings.ExecutionTimeLimit = 'PT1M'
$logon = $definition.Triggers.Create(9)
$logon.UserId = $userId
$logon.Repetition.Interval = 'PT1M'
$clockTrigger = $definition.Triggers.Create(1)
$clockTrigger.StartBoundary = (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
$clockTrigger.Repetition.Interval = 'PT1M'
$action = $definition.Actions.Create(0)
$action.Path = Join-Path $env:SystemRoot 'System32\wscript.exe'
$action.Arguments = '"' + $resolvedLauncher + '"'
$null = $folder.RegisterTaskDefinition($taskName, $definition, 6, $userId, $null, 3)
Write-Output 'YuQu transcription logon startup and minute recovery check installed.'
