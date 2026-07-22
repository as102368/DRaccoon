@echo off
setlocal EnableDelayedExpansion
set "LATEST="
for /d %%D in ("%~dp0dist\DRaccoon-release*") do set "LATEST=%%D"
if not defined LATEST (
    echo Build directory not found. Please run scripts/build_electron.py first.
    pause
    exit /b 1
)
start "" "%LATEST%\DRaccoon.exe" "%~dp0app"
