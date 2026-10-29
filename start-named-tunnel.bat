@echo off
setlocal
if "%~1"=="" (
  echo Usage: start-named-tunnel.bat TUNNEL_NAME
  exit /b 2
)
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cloudflared was not found in PATH.
  exit /b 1
)
cloudflared tunnel --protocol quic run "%~1"
