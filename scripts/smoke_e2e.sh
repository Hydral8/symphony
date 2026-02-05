#!/usr/bin/env bash
set -euo pipefail

if python3 -c 'import importlib.util as u; raise SystemExit(0 if u.find_spec("pytest") else 1)'; then
  python3 -m pytest -q tests/test_integration_e2e.py
  exit 0
fi

if PYENV_VERSION=3.11.9 python3 -c 'import importlib.util as u; raise SystemExit(0 if u.find_spec("pytest") else 1)'; then
  PYENV_VERSION=3.11.9 python3 -m pytest -q tests/test_integration_e2e.py
  exit 0
fi

echo "pytest not available in local interpreters (python3 or PYENV_VERSION=3.11.9)." >&2
exit 1
