#!/bin/sh
# Starts Tailscale, then the Memo server as the user "node". Runs as root, as the first process of the Machine.
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
else
  echo "Tailscale is not signed in. Run in fly ssh console: tailscale up --hostname=${TS_HOSTNAME:-memo}"
fi

# The agent sessions get this environment through tmux. scripts/ is in PATH so that the agent can run "memo".
export HOME="$data/home" MEMO_LOCAL="$data/local" DATABASE_PATH="$data/memo/memo.db" HOST=127.0.0.1 PORT=3280
export PATH="/app/scripts:$PATH"
unset TS_AUTHKEY
# as-agent reads the token from this file. /run is in memory; the file is not in the image and not on the volume.
(umask 077; printf 'MEMO_TOKEN=%s\n' "$MEMO_TOKEN" > /run/memo.env); chown node:node /run/memo.env
cd /app
exec gosu node node --disable-warning=ExperimentalWarning src/server.js
