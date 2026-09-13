$ErrorActionPreference = 'Stop'
$taskName = 'BPJS-USG-OrthancBridge'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Task $taskName berhasil dihapus. Berkas konfigurasi dan log tetap disimpan."
} else {
  Write-Output "Task $taskName tidak ditemukan."
}
