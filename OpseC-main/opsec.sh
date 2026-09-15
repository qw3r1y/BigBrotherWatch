#!/bin/bash
# OpSec Dashboard launcher.
# Starts the local web UI at http://127.0.0.1:8765 (localhost only).

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
    echo "[!] OpSec manages system services and packages — relaunching with sudo..."
    exec sudo -E bash "$0" "$@"
fi

PYTHON_BIN="$(command -v python3 || true)"
if [ -z "$PYTHON_BIN" ]; then
    echo "[*] python3 not found — installing it..."
    if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y python3
    elif command -v dnf >/dev/null 2>&1; then dnf install -y python3
    elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm python3
    else echo "[-] Could not find a supported package manager to install python3."; exit 1
    fi
    PYTHON_BIN="$(command -v python3)"
fi

chmod +x "$DIR/core/opsec_core.sh" 2>/dev/null || true

exec "$PYTHON_BIN" "$DIR/server/opsec_server.py"
