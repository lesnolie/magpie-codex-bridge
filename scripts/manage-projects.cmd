@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0manage-projects.ps1"
if errorlevel 1 (
  echo Failed to open the local project manager.
  pause
)
