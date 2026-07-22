# DRaccoon PyInstaller Build Script
# Run in external PowerShell terminal (IDE sandbox may block Python libs)
#
# Usage:
#   1. Open PowerShell terminal
#   2. cd to this directory
#   3. .\build.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AssetsDir = Join-Path $ScriptDir "assets"
$RootDir = Join-Path $ScriptDir ".."

Write-Host "=== DRaccoon PyInstaller Build Script ===" -ForegroundColor Cyan
Write-Host "Working directory: $AssetsDir"
Write-Host ""

# Check PyInstaller
$pyiCheck = & py -3 -c "import PyInstaller; print(PyInstaller.__version__)" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "PyInstaller not found, installing..." -ForegroundColor Yellow
    & py -3 -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) {
        Write-Host "PyInstaller installation failed!" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "PyInstaller version: $pyiCheck" -ForegroundColor Green
}

# Clean old builds and stale bytecode to ensure updated .py source is bundled
$buildDir = Join-Path $AssetsDir "build"
$distDir = Join-Path $AssetsDir "dist"
$specFile = Join-Path $AssetsDir "dispatcher.spec"

if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }
if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
if (Test-Path $specFile) { Remove-Item $specFile -Force }

Get-ChildItem -Path (Join-Path $RootDir "backend"), (Join-Path $RootDir "python") -Recurse -Filter "__pycache__" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force
}

Set-Location $AssetsDir

Write-Host ""
Write-Host "=== Starting PyInstaller build ===" -ForegroundColor Cyan
Write-Host "This may take 2-5 minutes, please wait..."
Write-Host ""

& py -3 -m PyInstaller `
    --name dispatcher `
    --onedir `
    --windowed `
    --noconfirm `
    --collect-all rich `
    --collect-all aiohttp `
    --collect-all oss2 `
    --collect-all boto3 `
    --collect-all cryptography `
    --collect-all opencc `
    --collect-all gmssl `
    --collect-all mutagen `
    --collect-all openpyxl `
    --collect-all imageio_ffmpeg `
    --collect-all dateutil `
    --collect-all yaml `
    --collect-all aiosqlite `
    --collect-all aiofiles `
    --add-data "..\..\backend;backend" `
    --add-data "..\..\python;python" `
    --hidden-import runpy `
    --hidden-import lib.bridge `
    --hidden-import lib.compat `
    --hidden-import lib.redactor `
    dispatcher.py

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "=== Build failed! ===" -ForegroundColor Red
    exit 1
}

$dispatcherExe = Join-Path $distDir "dispatcher\dispatcher.exe"
if (Test-Path $dispatcherExe) {
    $fileInfo = Get-Item $dispatcherExe
    $sizeMB = [math]::Round($fileInfo.Length / 1MB, 1)
    Write-Host ""
    Write-Host "=== Build successful! ===" -ForegroundColor Green
    Write-Host "Output: $dispatcherExe"
    Write-Host "Size: $sizeMB MB"
    Write-Host ""

    # Quick test (running without arguments prints usage; ignore stderr)
    Write-Host "=== Quick test dispatcher ===" -ForegroundColor Cyan
    & $dispatcherExe 2>&1 | Out-Null
    Write-Host "Dispatcher executable is runnable (exit code: $LASTEXITCODE)" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "=== Build may have failed: dispatcher.exe not found ===" -ForegroundColor Red
}

Write-Host ""
Write-Host "Build complete" -ForegroundColor DarkGray
