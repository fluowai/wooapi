#!/bin/sh
set -eu

stop_children() {
  kill "$bridge_pid" "$v2_pid" "$app_pid" 2>/dev/null || true
}

trap stop_children TERM INT

(
  while true; do
    echo "[container] starting go bridge"
    ./go-bridge/bridge
    code=$?
    echo "[container] go bridge exited with code $code; restarting in 2s"
    sleep 2
  done
) &
bridge_pid=$!

(
  while true; do
    echo "[container] starting Wozapi v2 bridge"
    npm run engine:v2
    code=$?
    echo "[container] Wozapi v2 bridge exited with code $code; restarting in 2s"
    sleep 2
  done
) &
v2_pid=$!

npm run start &
app_pid=$!

wait "$app_pid"
app_code=$?
echo "[container] app exited with code $app_code"
stop_children
exit "$app_code"
