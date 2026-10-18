#!/usr/bin/env bash
set -u

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/gateway.pid"
GATEWAY_PATH="$ROOT_DIR/gateway.py"
ENV_FILE="$ROOT_DIR/.env"

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

listener_pids() {
    if command -v ss >/dev/null 2>&1; then
        ss -ltnp 2>/dev/null | awk -v port=":$PORT" '$4 ~ (port "$|\\]" port "$")' |
            grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
    fi
}

is_gateway_pid() {
    local pid=$1
    local command
    command=$(ps -p "$pid" -o args= 2>/dev/null || true)
    [[ "$command" == *"$GATEWAY_PATH"* ]] && return 0
    [[ "$command" == *"gateway.py"* ]] && grep -qx "$pid" < <(listener_pids)
}

stop_pid() {
    local pid=$1
    if ! [[ "$pid" =~ ^[0-9]+$ ]] || ! is_gateway_pid "$pid"; then
        return 1
    fi
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 0.1
    done
    kill -KILL "$pid" 2>/dev/null || true
}

if [[ -f "$PID_FILE" ]]; then
    pid=$(tr -d '[:space:]' < "$PID_FILE")
    stop_pid "$pid" || true
    rm -f "$PID_FILE"
fi

while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    stop_pid "$pid" || true
done < <(ps -eo pid=,args= 2>/dev/null | awk -v path="$GATEWAY_PATH" 'index($0, path) {print $1}')

echo "网关已停止（如存在可识别的实例）"
