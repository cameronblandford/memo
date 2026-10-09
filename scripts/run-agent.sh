#!/bin/sh
# Runs one short, unattended session of the liaison agent and exits. The Discord watcher starts it.
#   scripts/run-agent.sh liaison
# The session gets no MCP server, no plugins, no hooks, and only two commands: memo and the Discord command.
# In the charter, {{memo}} and {{discord}} become the full paths of the two commands.
# A lock stops two runs at the same time. A cap stops more than 8 runs in one hour.
#   MEMO_RUN_DRY=1 prints the claude command and starts nothing.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
name="${1:-}"
[ "$name" = liaison ] || { echo "Usage: scripts/run-agent.sh liaison" >&2; exit 1; }
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH
. "$root/scripts/_node.sh"
local_file() { if [ -e "${MEMO_LOCAL:-$root/local}/$1" ]; then echo "${MEMO_LOCAL:-$root/local}/$1"; else echo "$root/$1"; fi; }
# DISCORD_CLI in .env is the full path of the command that reads and sends Discord messages.
discord_cli="${DISCORD_CLI:-$(sed -n 's/^DISCORD_CLI=//p' "$root/.env" 2>/dev/null)}"
[ -n "$discord_cli" ] || { echo "DISCORD_CLI is not in .env. See .env.example." >&2; exit 1; }
allow_memo="Bash($root/scripts/memo:*)"
allow_discord="Bash($discord_cli:*)"
if [ -n "${MEMO_RUN_DRY:-}" ]; then
  echo "claude -p --model sonnet --strict-mcp-config --setting-sources \"\" --tools Bash --allowedTools \"$allow_memo\" \"$allow_discord\""
  echo "token: restricted"
  exit 0
fi
mkdir -p "$root/data" "$root/work/$name"
log="$root/data/$name-runs.log"
lock="$root/data/$name.lock"
if ! mkdir "$lock" 2>/dev/null; then
  # A lock older than 30 minutes is from a run that died.
  if [ -n "$(find "$lock" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rmdir "$lock" 2>/dev/null || true; mkdir "$lock"; else echo "$(date -u +%FT%TZ) $name: a run is active, skipped" >> "$log"; exit 0; fi
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
recent="$(awk -v since="$(date -u -v-1H +%FT%TZ)" '$2 ~ /start/ && $1 > since' "$log" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${recent:-0}" -ge 8 ]; then echo "$(date -u +%FT%TZ) $name: 8 runs in the last hour, skipped" >> "$log"; exit 0; fi
# The liaison reads text from other people, so the run gets the restricted token. With it the server permits only:
# read the memos to liaison, send a memo to the owner, close a memo to liaison, and forward a Discord message that the owner wrote.
MEMO_TOKEN="$(sed -n 's/^MEMO_LIAISON_TOKEN=//p' "$root/.env")"; export MEMO_TOKEN
[ -n "$MEMO_TOKEN" ] || { echo "$(date -u +%FT%TZ) $name: MEMO_LIAISON_TOKEN is not in .env, skipped" >> "$log"; exit 1; }
# The Agents page shows the time of this status line as the last run.
"$root/scripts/memo" status --as "$name" "A short run for Discord mail." >/dev/null 2>&1 || true
cd "$root/work/$name"
echo "$(date -u +%FT%TZ) start $name" >> "$log"
claude -p --model sonnet --strict-mcp-config --setting-sources "" --tools "Bash" --allowedTools "$allow_memo" "$allow_discord" -- "$(sed -e "s|{{memo}}|$root/scripts/memo|g" -e "s|{{discord}}|$discord_cli|g" "$(local_file "charters/$name.md")")

Start now." >> "$log" 2>&1 < /dev/null || echo "$(date -u +%FT%TZ) $name: claude exited with an error" >> "$log"
echo "$(date -u +%FT%TZ) end $name" >> "$log"
