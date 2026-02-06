#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
UI_PORT="${UI_PORT:-5173}"
MODE="${1:-dev}"
BACKEND_PID=""

usage() {
  cat <<EOF
Usage: scripts/run_all.sh [dev|prod|backend]

Modes:
  dev      Start backend API + Vite frontend (default)
  prod     Build frontend and serve it from backend only
  backend  Start backend only

Environment overrides:
  HOST=127.0.0.1
  API_PORT=8787
  UI_PORT=5173
EOF
}

cleanup() {
  if [[ -n "${BACKEND_PID}" ]] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill "${BACKEND_PID}" 2>/dev/null || true
  fi
}

start_backend_bg() {
  python3 "${ROOT_DIR}/pw.py" web --host "${HOST}" --port "${API_PORT}" &
  BACKEND_PID=$!
  sleep 1
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    echo "Backend failed to start on ${HOST}:${API_PORT}" >&2
    exit 1
  fi
}

case "${MODE}" in
  dev)
    trap cleanup EXIT INT TERM
    start_backend_bg
    echo "Backend:  http://${HOST}:${API_PORT}"
    echo "Frontend: http://${HOST}:${UI_PORT}"
    npm --prefix "${ROOT_DIR}/webapp" run dev -- --host "${HOST}" --port "${UI_PORT}"
    ;;
  prod)
    npm --prefix "${ROOT_DIR}/webapp" run build
    python3 "${ROOT_DIR}/pw.py" web --host "${HOST}" --port "${API_PORT}"
    ;;
  backend)
    python3 "${ROOT_DIR}/pw.py" web --host "${HOST}" --port "${API_PORT}"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown mode: ${MODE}" >&2
    usage
    exit 1
    ;;
esac
