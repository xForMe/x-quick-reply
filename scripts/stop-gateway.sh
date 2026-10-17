#!/usr/bin/env bash
set -u

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/gateway.pid"
GATEWAY_PATH="$ROOT_DIR/gateway.py"

is_gateway_pid() {
    local pid=$1
    local command
    command=$(ps -p "$pid" -o args= 2>/dev/null || true)
    [[ "$command" == *"$GATEWAY_PATH"* ]]
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
