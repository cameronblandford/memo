#!/bin/sh
# Runs a command as the agent user, with the environment of the agent. Use it in "fly ssh console", which is root.
#   as-agent claude            sign in to Claude Code one time
#   as-agent tmux attach -t memo-main
set -eu
data="${MEMO_DATA:-/data}"
# The entrypoint wrote the token to /run/memo.env, so that "as-agent memo ..." works.
if [ -z "${MEMO_TOKEN:-}" ] && [ -r /run/memo.env ]; then
  MEMO_TOKEN="$(sed -n 's/^MEMO_TOKEN=//p' /run/memo.env)"; export MEMO_TOKEN
fi
export HOME="$data/home" MEMO_LOCAL="$data/local" PATH="/app/scripts:$PATH"
mkdir -p "$HOME/work" && chown node:node "$HOME/work"
cd "$HOME/work"
[ "$#" -gt 0 ] || set -- bash
exec gosu node "$@"
