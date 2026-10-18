#!/bin/sh
# Starts Tailscale, the optional Discord watcher, then the Memo server as the user "node". Runs as root, as the first process of the Machine.
# The volume /data holds: memo/ (the database and the images), home/ (the home directory of the agent, with the
# Claude Code sign-in), local/ (agents.json and the charters), and tailscale/ (the state of this device).
set -eu
data="${MEMO_DATA:-/data}"
mkdir -p "$data/memo" "$data/home" "$data/local" "$data/tailscale"
chown node:node "$data/memo" "$data/home" "$data/local"
chmod 700 "$data/memo" "$data/home" "$data/tailscale"

# Tailscale is the only way in: the Machine has no public service. The state on the volume keeps the device in
# the tailnet. For the first sign-in, set TS_AUTHKEY, or run "tailscale up" in "fly ssh console" and open the link.
mkdir -p /var/run/tailscale
tailscaled --state="$data/tailscale/tailscaled.state" --socket=/var/run/tailscale/tailscaled.sock \
  --tun=userspace-networking >/var/log/tailscaled.log 2>&1 &
n=0; until tailscale version --daemon >/dev/null 2>&1 || [ "$n" -ge 20 ]; do n=$((n + 1)); sleep 0.5; done
if [ -n "${TS_AUTHKEY:-}" ]; then tailscale up --hostname="${TS_HOSTNAME:-memo}" --authkey="$TS_AUTHKEY" || true; fi
if tailscale status >/dev/null 2>&1; then
  tailscale serve --bg --https=443 http://127.0.0.1:3280 || echo "Tailscale Serve did not start."
  # Plain HTTP inside the tailnet only, for the short name (http://memo/inbox). The server sends it on to the HTTPS name.
  tailscale serve --bg --http=80 http://127.0.0.1:3280 || echo "Tailscale Serve on port 80 did not start."
else
  echo "Tailscale is not signed in. Run in fly ssh console: tailscale up --hostname=${TS_HOSTNAME:-memo}"
fi

# The agent sessions get this environment through tmux. scripts/ is in PATH so that the agent can run "memo".
export HOME="$data/home" MEMO_LOCAL="$data/local" DATABASE_PATH="$data/memo/memo.db" HOST=127.0.0.1 PORT=3280
export PATH="/app/scripts:$PATH"
unset TS_AUTHKEY
# as-agent reads the token from this file. /run is in memory; the file is not in the image and not on the volume.
(umask 077; printf 'MEMO_TOKEN=%s\n' "$MEMO_TOKEN" > /run/memo.env); chown node:node /run/memo.env

# Discord (optional): with the secret DISCORD_BOT_TOKEN, a loop runs the watcher each 30 seconds, as launchd does
# on macOS. The loop continues when a run fails. The token goes to a file of the agent user, not into the environment of the agents.
if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
  mkdir -p "$HOME/.config" && chown node:node "$HOME/.config"
  (umask 077; printf '%s\n' "$DISCORD_BOT_TOKEN" > "$HOME/.config/discord-bot-token"); chown node:node "$HOME/.config/discord-bot-token"
  unset DISCORD_BOT_TOKEN
  export MEMO_STATE_DIR="$data/memo" MEMO_WORK_DIR="$HOME/work"
  (
    sleep 10
    while :; do
      gosu node python3 /app/scripts/discord-watch.py >> "$data/memo/discord-watch.log" 2>&1 || true
      sleep 30
    done
  ) &
fi
cd /app
exec gosu node node --disable-warning=ExperimentalWarning src/server.js
