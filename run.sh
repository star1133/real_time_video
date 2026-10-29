#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -x .venv/bin/python ]]; then
  python_bin=.venv/bin/python
else
  python_bin=.venv/Scripts/python.exe
fi
exec "$python_bin" -m uvicorn main:app --host 127.0.0.1 --port 3055 --workers 1 --ws websockets --ws-max-size 16384 --ws-max-queue 16 --ws-per-message-deflate false
