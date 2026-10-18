# Build dist\TripoModelManager.exe on Windows (PowerShell, Python 3.9+ on PATH).
#   powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

python -m venv .venv-build
.\.venv-build\Scripts\python -m pip install --upgrade pip
.\.venv-build\Scripts\python -m pip install ".[app]" "pyinstaller>=6.22,<7"

.\.venv-build\Scripts\pyinstaller --noconfirm --clean --onefile --windowed `
    --name TripoModelManager `
    --collect-data tripo_export `
    packaging\windows\app_entry.py

Write-Host "Built dist\TripoModelManager.exe"
