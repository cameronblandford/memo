#!/bin/sh
# Starts the Claude Code session of one long Memo agent, in its work directory, with its charter.
#   scripts/agent.sh <name>
# The server runs this in the tmux session memo-<name> (src/agents.js). Do not run it by hand while that session exists.
#   MEMO_AGENT_DRY=1 prints the settings and the start text, and starts nothing.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
name="${1:?Usage: scripts/agent.sh <name>}"
# scripts/ is in PATH so that the agent can run "memo".
PATH="$root/scripts:$HOME/.local/bin:$HOME/Library/pnpm/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH
. "$root/scripts/_node.sh"
# A file of this installation is in local/ (git ignores it). If it is not there, the example in the repository applies.
local_file() { if [ -e "${MEMO_LOCAL:-$root/local}/$1" ]; then echo "${MEMO_LOCAL:-$root/local}/$1"; else echo "$root/$1"; fi; }
field() {
  node --input-type=commonjs -e '
    const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).find((x) => x.name === process.argv[2] && x.kind === "long");
    if (!a) process.exit(1);
    process.stdout.write(String(a[process.argv[3]]));' "$(local_file agents.json)" "$name" "$1"
}
dir="$(field dir)" || { echo "No long agent has the name $name in agents.json." >&2; exit 1; }
model="$(field model)"
case "$dir" in "~"*) dir="$HOME${dir#"~"}" ;; esac
# The server builds the start text: the charter, then the recap of the last session if one exists.
prompt="$(memo prompt --as "$name")"
# Claude Code settings for the agent sessions of this installation, for example plugins and MCP servers to switch off.
# The file is optional: local/agent-settings.json.
settings='{}'
[ -f "$(local_file agent-settings.json)" ] && settings="$(tr -d '\n' < "$(local_file agent-settings.json)")"
if [ -n "${MEMO_AGENT_DRY:-}" ]; then printf '%s\n---\n%s\n' "$settings" "$prompt"; exit 0; fi
mkdir -p "$dir"
cd "$dir"
# "--" ends the option list. Without it, claude can read the start text as an option value.
exec claude --model "${MEMO_AGENT_MODEL:-$model}" --settings "$settings" -- "$prompt

Start now: run \`memo list --to $name\`, then do the work."
