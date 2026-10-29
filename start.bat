@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Run setup.bat first.
  exit /b 1
)
".venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 3055 --workers 1 --ws websockets --ws-max-size 16384 --ws-max-queue 16 --ws-per-message-deflate false
