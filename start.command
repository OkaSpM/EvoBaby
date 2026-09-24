#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PYTHONPATH="$PWD/backend"
export LLM_MODE=mock
export JUDGE_MODE="${JUDGE_MODE:-mock}"
exec .venv/bin/python -m uvicorn app.main:app --host "${EVOBABY_HOST:-127.0.0.1}" --port "${PORT:-8781}"
