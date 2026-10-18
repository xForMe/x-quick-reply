#!/usr/bin/env bash
set -u

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT_DIR="$ROOT_DIR/scripts"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/gateway.pid"
ENV_FILE="$ROOT_DIR/.env"
PYTHON_BIN=${PYTHON_BIN:-python3}

read_port() {
    if [[ -f "$ENV_FILE" ]]; then
        awk -F= '/^[[:space:]]*QUICK_REPLY_PORT[[:space:]]*=/ {
            value=$2
            sub(/[[:space:]]*#.*/, "", value)
            gsub(/[[:space:]]/, "", value)
            gsub(/^"|"$/, "", value)
            gsub(/^'"'"'|'"'"'$/, "", value)
            if (value ~ /^[0-9]+$/) print value
        }' "$ENV_FILE" | tail -n 1
    fi
}

PORT=${QUICK_REPLY_PORT:-$(read_port)}
PORT=${PORT:-8787}

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    echo "启动失败：找不到 Python 命令 $PYTHON_BIN" >&2
    exit 1
fi

"$SCRIPT_DIR/stop-gateway.sh" >/dev/null
mkdir -p "$LOG_DIR"

if [[ -n "${QUICK_REPLY_PORT:-}" ]]; then
    export QUICK_REPLY_PORT
fi
nohup "$PYTHON_BIN" "$ROOT_DIR/gateway.py" >"$LOG_DIR/gateway.log" 2>"$LOG_DIR/gateway.error.log" < /dev/null &
PID=$!
printf '%s\n' "$PID" > "$PID_FILE"

check_health() {
    "$PYTHON_BIN" - "$PORT" <<'PY'
import http.client
import json
import sys

port = int(sys.argv[1])
try:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
    conn.request("GET", "/health", headers={"Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
    response = conn.getresponse()
    body = response.read()
    conn.close()
    data = json.loads(body)
    raise SystemExit(0 if response.status == 200 and data.get("ok") is True else 1)
except (OSError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
PY
}

for _ in $(seq 1 50); do
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "启动失败：网关进程已退出" >&2
        rm -f "$PID_FILE"
        exit 1
    fi
    if check_health; then
        echo "网关已启动：http://127.0.0.1:$PORT（PID $PID）"
        exit 0
    fi
    sleep 0.1
done

echo "启动失败：网关未在预期时间内通过健康检查" >&2
"$SCRIPT_DIR/stop-gateway.sh" >/dev/null
exit 1
