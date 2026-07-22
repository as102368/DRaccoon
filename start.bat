@echo off
setlocal EnableDelayedExpansion
set "LATEST="
set "LATEST_NAME="
for /d %%D in ("%~dp0dist\DRaccoon-release-build-*") do (
    if exist "%%D\DRaccoon.exe" (
        set "THIS_NAME=%%~nxD"
        if "!THIS_NAME!" gtr "!LATEST_NAME!" (
            set "LATEST_NAME=!THIS_NAME!"
            set "LATEST=%%D"
        )
    )
)
if not defined LATEST (
    echo Build directory not found. Please run scripts/build_electron.py first.
    pause
    exit /b 1
)
start "" "%LATEST%\DRaccoon.exe" "%~dp0app"
