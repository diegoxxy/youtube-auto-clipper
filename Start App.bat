@echo off
setlocal enabledelayedexpansion

title YouTube Auto Clipper - Setup & Launch

echo ============================================
echo  YouTube Auto Clipper - Offline Desktop App
echo ============================================
echo.

REM Cek Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

REM Cek FFmpeg
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo ERROR: FFmpeg not found.
    echo Install: winget install Gyan.FFmpeg
    pause
    exit /b 1
)

echo Checking setup status...
if exist node_modules (
    echo Setup already done. Starting app...
    goto :start_app
) else (
    echo First run - installing packages...
)

echo.
echo Running setup...
call npm run setup
if errorlevel 1 (
    echo Setup failed!
    pause
    exit /b 1
)

:start_app
echo.
echo ============================================
echo Launching YouTube Auto Clipper...
echo (Browser will open in 10 seconds)
echo.
echo App running. Press Ctrl+C in this window to stop.
echo ============================================
echo.

call npm start
pause
