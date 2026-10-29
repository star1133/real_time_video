@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Run setup.bat first.
  exit /b 1
)

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cloudflared was not found in PATH.
  exit /b 1
)

start "Watch Party server" cmd /k call "%~dp0start.bat"
timeout /t 2 /nobreak >nul
start "Watch Party tunnel" cmd /k call "%~dp0start-tunnel.bat"

echo Watch Party server and Cloudflare tunnel started.
echo Public URL: (set your public URL)