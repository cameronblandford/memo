#!/bin/sh
# Keeps the session of one remote agent on this computer. The Memo server is on a different computer.
#   scripts/remote-agent.sh <name>
# Each 15 seconds: if the server answers and the tmux session memo-<name> does not exist, it starts the session.
# While the session exists, it sends the tail of the session ("memo screen") to the Agents page. That also shows the
# agent online while it works. The answer can hold keys from the page (Escape or Enter); the script sends them to the session.
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
    # A server without the screen route (an older version) refuses it. Then "memo ping" keeps the agent online.
    keys="$(tmux capture-pane -p -J -S -100 -t "=$session:" 2>/dev/null | memo screen --as "$name" 2>/dev/null)" \
      || { keys=""; memo ping --as "$name" >/dev/null 2>&1 || true; }
    for k in $keys; do
      # The session can end between the screen and the key. A failed key must not end this loop (set -e).
      case "$k" in Escape|Enter) tmux send-keys -t "=$session:" "$k" 2>/dev/null || true ;; esac
    done
  elif memo prompt --as "$name" >/dev/null 2>&1; then
    tmux new-session -d -s "$session" -x 200 -y 50 "$root/scripts/agent.sh" "$name"
    echo "$(date -u +%FT%TZ) started $session"
  fi
  [ -z "${MEMO_REMOTE_ONCE:-}" ] || exit 0
  sleep 15
done
