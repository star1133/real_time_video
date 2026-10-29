FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 WATCHPARTY_LOG_FILE=""
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
COPY managers managers
COPY static static
COPY templates templates
USER 10001:10001
EXPOSE 3055
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3055", "--workers", "1", "--ws", "websockets", "--ws-max-size", "16384", "--ws-max-queue", "16", "--ws-per-message-deflate", "false", "--forwarded-allow-ips", "*", "--no-access-log"]
