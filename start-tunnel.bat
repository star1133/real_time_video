@echo off
setlocal
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cloudflared was not found in PATH.
  exit /b 1
)
cloudflared tunnel --config "C:\Users\12345\.cloudflared\config-watchparty.yml" run
