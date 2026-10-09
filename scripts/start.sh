#!/bin/sh
# Starts the Memo server in the foreground. A LaunchAgent can run this at login (see README.md).
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
# The server starts tmux, and tmux starts claude. A LaunchAgent has a short PATH, so add their directories.
PATH="$HOME/.local/bin:$HOME/Library/pnpm/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH
. "$root/scripts/_node.sh"
cd "$root"
[ -f .env ] || { echo "The file .env is missing. Copy .env.example to .env and set the tokens." >&2; exit 1; }
[ -d node_modules ] || npm ci
mkdir -p data
exec node --env-file=.env --disable-warning=ExperimentalWarning src/server.js
