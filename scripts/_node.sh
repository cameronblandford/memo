# Sourced by the other scripts. Puts Node 22.13 or later first in PATH (the server uses node:sqlite).
node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; }
if ! node_ok; then
  for d in /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@24/bin /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$d/node" ]; then PATH="$d:$PATH"; node_ok && break; fi
  done
fi
if ! node_ok; then
  echo "Node 22.13 or later is necessary. Found: $(node -v 2>/dev/null || echo none)." >&2
  exit 1
fi
export PATH
