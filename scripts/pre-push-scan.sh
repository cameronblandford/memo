#!/bin/sh
# Scans the commits of a push for personal data and secrets, and stops the push if it finds something.
# Install it as the pre-push hook of this checkout:
#   ln -s ../../scripts/pre-push-scan.sh .git/hooks/pre-push
# Scan a range by hand:
#   scripts/pre-push-scan.sh --range origin/main..main
# The scan reads the lines that the commits add, and the commit messages. It looks for:
#   - the general patterns below: tokens, private keys, home directories, tailnet names, mail addresses, phone numbers;
#   - your own patterns in local/scan-patterns.txt (one extended regular expression in each line, "#" for a comment).
#     Put your names, addresses, host names, and account ids there. Git ignores local/, so they stay private.
# A line that matches an expression in local/scan-allow.txt is not a finding.
set -eu
# Git runs a hook in the top directory of the checkout. By hand, run the script from inside the checkout.
root="$(git rev-parse --show-toplevel)"
cd "$root"
local_dir="${MEMO_LOCAL:-$root/local}"
zero=0000000000000000000000000000000000000000
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/patterns" <<'EOF'
-----BEGIN [A-Z ]*PRIVATE KEY-----
sk-ant-[A-Za-z0-9_-]{20,}
gh[pousr]_[A-Za-z0-9]{30,}
github_pat_[A-Za-z0-9_]{30,}
xox[abprs]-[A-Za-z0-9-]{10,}
AKIA[0-9A-Z]{16}
tskey-[a-z]+-[A-Za-z0-9-]{10,}
FlyV1 [A-Za-z0-9_+/=-]{20,}
[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}
(TOKEN|SECRET|PASSWORD|API_KEY|AUTHKEY)[A-Z_]*["']?[=:] *["']?[A-Za-z0-9_/+-]{24,}
/Users/[A-Za-z0-9._-]+/
/home/[a-z0-9._-]+/
[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net
[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[a-z]{2,}
(^|[^0-9.])(\+1[ .-]?)?\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}([^0-9]|$)
EOF
# Text that the general patterns match, and that is not personal.
cat > "$tmp/allow" <<'EOF'
@example\.(com|org|net)
noreply@
@users\.noreply\.github\.com
git@github\.com
/Users/(you|name|example)/
/home/(you|name|node)/
EOF
if [ -f "$local_dir/scan-patterns.txt" ]; then grep -v -E '^[[:space:]]*(#|$)' "$local_dir/scan-patterns.txt" >> "$tmp/patterns" || true
else echo "pre-push-scan: no file $local_dir/scan-patterns.txt, so only the general patterns apply." >&2; fi
if [ -f "$local_dir/scan-allow.txt" ]; then grep -v -E '^[[:space:]]*(#|$)' "$local_dir/scan-allow.txt" >> "$tmp/allow" || true; fi

# An error stops the push: a scan that did not run is not a clean scan.
stop() { echo "pre-push-scan: the push stops. The scan failed: $1" >&2; exit 2; }

# Prints one line for each added line and each message line of the commits: "<commit> <file or message>: <text>".
lines() {
  # shellcheck disable=SC2086
  git log -p --no-color --no-ext-diff --format='commit %H%n%B%n---' $1 > "$tmp/log" || stop "git could not read the commits of $1."
  awk '
    /^commit [0-9a-f]{40}$/ { c = substr($2, 1, 8); f = "message"; next }
    /^diff --git / { f = "diff"; next }
    /^\+\+\+ / { f = substr($0, 5); sub(/^b\//, "", f); next }
    f == "message" { if ($0 != "" && $0 != "---") print c " message: " $0; next }
    /^\+/ { print c " " f ": " substr($0, 2) }' "$tmp/log"
}

: > "$tmp/lines"
if [ "${1:-}" = --range ]; then
  lines "${2:?Usage: scripts/pre-push-scan.sh --range <range>}" >> "$tmp/lines"
else
  # Git gives a hook two arguments (the remote and its address) and the refs on stdin. Without arguments, a run by
  # hand would wait on stdin with no end, so it stops.
  [ "$#" -ge 1 ] || { echo "Usage: scripts/pre-push-scan.sh --range <range> (git gives the hook its arguments)." >&2; exit 2; }
  remote="$1"
  while read -r _ sha _ remote_sha; do
    [ "$sha" != "$zero" ] || continue   # a deleted branch has no commits
    if [ "$remote_sha" = "$zero" ]; then lines "$sha --not --remotes=$remote" >> "$tmp/lines"
    else lines "$remote_sha..$sha" >> "$tmp/lines"; fi
  done
fi

# grep ends with 0 for a match, 1 for no match, and 2 for an error (for example an expression that is not valid
# in local/scan-patterns.txt).
status=0; grep -E -f "$tmp/patterns" "$tmp/lines" > "$tmp/matches" || status=$?
[ "$status" -le 1 ] || stop "grep could not use the patterns. Check local/scan-patterns.txt."
status=0; grep -v -E -f "$tmp/allow" "$tmp/matches" > "$tmp/found" || status=$?
[ "$status" -le 1 ] || stop "grep could not use the allow list. Check local/scan-allow.txt."
found="$(cat "$tmp/found")"
if [ -n "$found" ]; then
  {
    echo "pre-push-scan: the push stops. These lines look like personal data or a secret:"
    echo "$found" | cut -c1-200
    echo "Remove the text from the commits, or add an expression to local/scan-allow.txt if the text is not personal."
  } >&2
  exit 1
fi
echo "pre-push-scan: clean ($(wc -l < "$tmp/lines" | tr -d ' ') lines)." >&2
