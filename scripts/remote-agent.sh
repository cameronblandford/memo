#!/bin/sh
# Keeps the session of one remote agent on this computer. The Memo server is on a different computer.
#   scripts/remote-agent.sh <name>
# Each minute: if the server answers and the tmux session memo-<name> does not exist, it starts the session.
# While the session exists, it sends "memo ping", so that the Agents page shows the agent online also while it works.
# When the server does not answer (this computer is offline), it starts nothing. A session that exists continues.
# The file .env of this computer needs MEMO_URL and MEMO_TOKEN. A LaunchAgent can run this script at login.
#   MEMO_REMOTE_ONCE=1 does one check and exits.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
name="${1:?Usage: scripts/remote-agent.sh <name>}"
case "$name" in *[!a-z0-9-]*|"") echo "The name must have only a-z, 0-9 and \"-\"." >&2; exit 1 ;; esac
PATH="$root/scripts:$HOME/.local/bin:$HOME/Library/pnpm/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH
. "$root/scripts/_node.sh"
session="memo-$name"
while :; do
  if tmux has-session -t "=$session" 2>/dev/null; then
    memo ping --as "$name" >/dev/null 2>&1 || true
  elif memo prompt --as "$name" >/dev/null 2>&1; then
    tmux new-session -d -s "$session" -x 200 -y 50 "$root/scripts/agent.sh" "$name"
    echo "$(date -u +%FT%TZ) started $session"
  fi
  [ -z "${MEMO_REMOTE_ONCE:-}" ] || exit 0
  sleep 60
done
