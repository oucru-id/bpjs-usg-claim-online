$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPath = Join-Path $bridgeRoot '.venv'

if (-not (Test-Path -LiteralPath $venvPath)) {
  python -m venv $venvPath
}

$pythonPath = Join-Path $venvPath 'Scripts\python.exe'
& $pythonPath -m pip install --upgrade pip
& $pythonPath -m pip install -r (Join-Path $bridgeRoot 'requirements.txt')

$configPath = Join-Path $bridgeRoot 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  Copy-Item -LiteralPath (Join-Path $bridgeRoot 'config.example.json') -Destination $configPath
}

Write-Output 'Persiapan selesai. Edit config.json, lalu jalankan .\run-once.ps1.'
