@echo off
setlocal
cd /d "%~dp0"
where uv >nul 2>nul
if errorlevel 1 (
  echo [ERROR] uv is required. Install it from https://docs.astral.sh/uv/
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" uv venv .venv
uv pip install --python ".venv\Scripts\python.exe" -r requirements.txt
if errorlevel 1 exit /b 1
echo Setup complete.
