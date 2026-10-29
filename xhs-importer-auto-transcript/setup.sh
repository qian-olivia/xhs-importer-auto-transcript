#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "本机语音转录需要 Apple Silicon Mac。" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 Python 3，请先安装 Python 3。" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime_dir="$HOME/Library/Application Support/xhs-importer-transcript"
python3 -m venv "$runtime_dir/.venv"
"$runtime_dir/.venv/bin/python" -m pip install --upgrade pip
"$runtime_dir/.venv/bin/python" -m pip install -r "$script_dir/requirements.txt"

echo "本地转录环境已安装：$runtime_dir/.venv"
