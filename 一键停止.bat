@echo off
rem ============================================
rem  Email Aggregator - One-click Stop (lite)
rem ============================================
title Email Aggregator - One-click Stop

echo Stopping Email Aggregator (port 3000)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "$left = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($left) { Write-Host 'Still running' } else { Write-Host 'Stopped' }"
pause