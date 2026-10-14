#!/usr/bin/env bash
# macOS / Linux entry point. Usage:  ./setup.sh --project /path/to/your/project [extra setup.mjs flags]
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (18+)."
  if command -v brew >/dev/null 2>&1; then
    read -r -p "Install Node.js with Homebrew now? [y/N] " a
    if [[ "$a" =~ ^(y|yes)$ ]]; then brew install node; else exit 1; fi
  else
    echo "Install it from https://nodejs.org (or your package manager) and run setup.sh again."; exit 1
  fi
fi
exec node "$(cd "$(dirname "$0")" && pwd)/scripts/setup.mjs" "$@"
