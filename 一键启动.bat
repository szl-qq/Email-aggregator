@echo off
rem ============================================
rem  Email Aggregator - One-click Start
rem  Single window: service runs in THIS console.
rem  Close this window (or Ctrl+C) to stop it.
rem ============================================
title Email Aggregator
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install from https://nodejs.org/
  pause
  exit /b 1
)

echo [1/2] Checking dependencies...
if not exist "node_modules" (
  echo       First run: installing npm packages...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check network and retry.
    pause
    exit /b 1
  )
)
echo       Dependencies ready

echo [2/2] Stopping old instance (port 3000)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

rem Open browser ~3s later without creating any extra window
start /b "" cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:3000"

echo Starting service: http://localhost:3000
echo Logs print below. Press Ctrl+C or close this window to stop.
echo ------------------------------------------------------------
node server.js

echo.
echo Service stopped.
pause
