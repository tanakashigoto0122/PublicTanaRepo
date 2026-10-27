# Build dist\TripoModelManager.exe on Windows (PowerShell, Python 3.9+ on PATH).
#   powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")

python -m venv .venv-build
.\.venv-build\Scripts\python -m pip install --upgrade pip
.\.venv-build\Scripts\python -m pip install ".[app]" "pyinstaller>=6.22,<7"

# gltfpack (meshoptimizer) for polygon reduction, pinned by hash.
$gltfpack = "src\tripo_export\vendor\gltfpack.exe"
if (-not (Test-Path $gltfpack)) {
    $zip = Join-Path $env:TEMP "gltfpack-windows.zip"
    Invoke-WebRequest "https://github.com/zeux/meshoptimizer/releases/download/v1.3/gltfpack-windows.zip" -OutFile $zip
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne "f6e9c09d66af23da3da71b86f0652d2413e81c734e0aecd1cd3d0e6e6e8645c0") { throw "unexpected gltfpack zip" }
    Expand-Archive $zip -DestinationPath (Join-Path $env:TEMP "gltfpack") -Force
    Copy-Item (Join-Path $env:TEMP "gltfpack\gltfpack.exe") $gltfpack
}

.\.venv-build\Scripts\pyinstaller --noconfirm --clean --onefile --windowed `
    --name TripoModelManager `
    --collect-data tripo_export `
    packaging\windows\app_entry.py

Write-Host "Built dist\TripoModelManager.exe"
