@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1"
echo.
echo If the dashboard did not open, copy the messages above and send them to Codex.
pause
