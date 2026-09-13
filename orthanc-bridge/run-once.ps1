$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $bridgeRoot '.venv\Scripts\python.exe') (Join-Path $bridgeRoot 'bridge.py') --config (Join-Path $bridgeRoot 'config.json') --once
