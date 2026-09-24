#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PYTHONPATH="$PWD/backend"
export LLM_MODE=mock
export JUDGE_MODE=mock
if [[ "${PORT:-8783}" == "8781" || "${PORT:-8783}" == "8782" ]]; then
  printf 'B uses port 8783 by default; 8781 and 8782 are reserved.\n' >&2
  exit 1
fi
exec .venv/bin/python -m uvicorn app.b_main:app --host 127.0.0.1 --port "${PORT:-8783}"
