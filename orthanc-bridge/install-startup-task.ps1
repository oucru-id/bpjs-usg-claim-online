$ErrorActionPreference = 'Stop'
$bridgeDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$runnerPath = Join-Path $bridgeDirectory 'run-continuous.ps1'
$taskName = 'BPJS-USG-OrthancBridge'

if (-not (Test-Path -LiteralPath (Join-Path $bridgeDirectory 'config.json'))) {
  throw 'config.json belum tersedia. Jalankan setup.ps1 dan isi konfigurasi terlebih dahulu.'
}

$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runnerPath + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Mengirim pemeriksaan USG baru dari Orthanc lokal ke BPJS USG web app.' -Force | Out-Null

Write-Output "Task $taskName dipasang untuk pengguna $env:USERNAME. Keluar-masuk Windows atau jalankan task secara manual untuk memulai."
