@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-cloudflare-mcp.ps1"
if errorlevel 1 pause
