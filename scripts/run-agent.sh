#!/bin/sh
# Runs one short, unattended session of the liaison agent and exits. The Discord watcher starts it.
#   scripts/run-agent.sh liaison
# The session gets no plugins, no hooks, and only two commands: memo and the Discord command.
# If MEMO_CALENDAR_MCP_ID is in .env, the session also gets the five read tools of the claude.ai Google Calendar connector.
# It gets no other MCP server and no other connector. The calendar write tools and the other connectors are also denied.
# In the charter, {{memo}} and {{discord}} become the full paths of the two commands.
# A lock stops two runs at the same time. A cap stops more than 8 runs in one hour.
#   MEMO_RUN_DRY=1 prints the claude command and starts nothing.
# MEMO_ENV_FILE replaces .env (the tests use it, so that they do not read the real .env).
# MEMO_STATE_DIR (the logs and the lock) and MEMO_WORK_DIR replace data/ and work/ when the repository is read-only.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
name="${1:-}"
[ "$name" = liaison ] || { echo "Usage: scripts/run-agent.sh liaison" >&2; exit 1; }
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH
. "$root/scripts/_node.sh"
env_file="${MEMO_ENV_FILE:-$root/.env}"
local_file() { if [ -e "${MEMO_LOCAL:-$root/local}/$1" ]; then echo "${MEMO_LOCAL:-$root/local}/$1"; else echo "$root/$1"; fi; }
# DISCORD_CLI in .env is the full path of the command that reads and sends Discord messages.
discord_cli="${DISCORD_CLI:-$(sed -n 's/^DISCORD_CLI=//p' "$env_file" 2>/dev/null || true)}"
[ -n "$discord_cli" ] || { echo "DISCORD_CLI is not in .env. See .env.example." >&2; exit 1; }
allow_memo="Bash($root/scripts/memo:*)"
allow_discord="Bash($discord_cli:*)"
# Cam's calendar, read only. MEMO_CALENDAR_MCP_ID is the id (mcpsrv_...) of the claude.ai Google Calendar connector.
# --strict-mcp-config stops the automatic claude.ai connectors, so the run loads only this one server from --mcp-config.
# An empty MEMO_CALENDAR_MCP_ID in the environment turns the calendar off; .env is read only when the variable is not set.
calendar_id="${MEMO_CALENDAR_MCP_ID-$(sed -n 's/^MEMO_CALENDAR_MCP_ID=//p' "$env_file" 2>/dev/null || true)}"
cal=mcp__claude_ai_Google_Calendar__
mcp_config='{"mcpServers":{}}'
allow_calendar=""
if [ -n "$calendar_id" ]; then
  printf '%s' "$calendar_id" | grep -Eq '^mcpsrv_[A-Za-z0-9]+$' || { echo "MEMO_CALENDAR_MCP_ID must look like mcpsrv_<letters and digits>." >&2; exit 1; }
  mcp_config="{\"mcpServers\":{\"claude.ai Google Calendar\":{\"type\":\"claudeai-proxy\",\"url\":\"https://mcp-proxy.anthropic.com/v1/mcp/$calendar_id\",\"id\":\"$calendar_id\"}}}"
  allow_calendar="${cal}list_events ${cal}search_events ${cal}get_event ${cal}list_calendars ${cal}suggest_time"
fi
deny="${cal}create_event ${cal}update_event ${cal}delete_event ${cal}respond_to_event mcp__claude_ai_Gmail mcp__claude_ai_Google_Drive mcp__claude_ai_Linear mcp__claude_ai_Notion mcp__claude_ai_Slack"
if [ -n "${MEMO_RUN_DRY:-}" ]; then
  echo "claude -p --model sonnet --strict-mcp-config --mcp-config '$mcp_config' --setting-sources \"\" --tools Bash --allowedTools \"$allow_memo\" \"$allow_discord\" $allow_calendar --disallowedTools $deny"
  echo "token: restricted"
  exit 0
fi
state="${MEMO_STATE_DIR:-$root/data}"
work="${MEMO_WORK_DIR:-$root/work}"
mkdir -p "$state" "$work/$name"
log="$state/$name-runs.log"
lock="$state/$name.lock"
if ! mkdir "$lock" 2>/dev/null; then
  # A lock older than 30 minutes is from a run that died.
  if [ -n "$(find "$lock" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rmdir "$lock" 2>/dev/null || true; mkdir "$lock"; else echo "$(date -u +%FT%TZ) $name: a run is active, skipped" >> "$log"; exit 0; fi
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
recent="$(awk -v since="$(date -u -v-1H +%FT%TZ 2>/dev/null || date -u -d '1 hour ago' +%FT%TZ)" '$2 ~ /start/ && $1 > since' "$log" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${recent:-0}" -ge 8 ]; then echo "$(date -u +%FT%TZ) $name: 8 runs in the last hour, skipped" >> "$log"; exit 0; fi
# The liaison reads text from other people, so the run gets the restricted token. With it the server permits only:
# read the memos to liaison, send a memo to the owner, answer in the thread of its own memo, close a memo to liaison, and forward a Discord message that the owner wrote.
MEMO_TOKEN="${MEMO_LIAISON_TOKEN:-$(sed -n 's/^MEMO_LIAISON_TOKEN=//p' "$env_file" 2>/dev/null || true)}"; export MEMO_TOKEN
[ -n "$MEMO_TOKEN" ] || { echo "$(date -u +%FT%TZ) $name: MEMO_LIAISON_TOKEN is not set, skipped" >> "$log"; exit 1; }
# The Agents page shows the time of this status line as the last run.
"$root/scripts/memo" status --as "$name" "A short run for Discord mail." >/dev/null 2>&1 || true
cd "$work/$name"
echo "$(date -u +%FT%TZ) start $name" >> "$log"
# $allow_calendar and $deny are lists of plain tool names without spaces, so they are not quoted.
# shellcheck disable=SC2086
claude -p --model sonnet --strict-mcp-config --mcp-config "$mcp_config" --setting-sources "" --tools "Bash" --allowedTools "$allow_memo" "$allow_discord" $allow_calendar --disallowedTools $deny -- "$(sed -e "s|{{memo}}|$root/scripts/memo|g" -e "s|{{discord}}|$discord_cli|g" "$(local_file "charters/$name.md")")

Start now." >> "$log" 2>&1 < /dev/null || echo "$(date -u +%FT%TZ) $name: claude exited with an error" >> "$log"
echo "$(date -u +%FT%TZ) end $name" >> "$log"
