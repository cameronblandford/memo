# Memo

Memo is a work queue for one person and their agents.

> **Warning.** Memo starts Claude Code sessions on your computer. An agent runs commands and changes files with the permissions of your user account and of your Claude Code settings. Read the charters before you start an agent, and give an agent only the directories and the tools that it needs. The Discord watcher brings text from other people to an agent; read "Discord" before you switch it on.

Memo has one concept, the memo. A memo is a message from one party to another party, with an optional reply.

| Use | From | To | End |
|---|---|---|---|
| A question for the owner | an agent | the owner | The owner replies. |
| A task that only the owner can do | an agent | the owner | The owner closes it. |
| Work for an agent | the owner | an agent | The agent closes it. |
| A Discord message | `discord` | `liaison` | The liaison closes it. |

The server uses Node 22.13 or later, Hono, and `node:sqlite`. It listens on `127.0.0.1:3280` only. The agents do not use MCP. They call the command `memo`.

## Start the server

1. Go to the directory of this repository.
2. Copy `.env.example` to `.env`, set the two tokens, and run `chmod 600 .env`.
3. Run `scripts/start.sh`.
4. Press Control-C to stop the server.

### Start at login (macOS)

1. Copy `launchd/memo.plist.example` to `~/Library/LaunchAgents/memo.server.plist`.
2. Replace each `__ROOT__` in the copy with the full path of this repository.
3. Run `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/memo.server.plist`.

Use `scripts/start.sh` by hand only when the LaunchAgent is not loaded.

Do a check: `curl http://127.0.0.1:3280/health` gives `{"ok":true}`.

## Configuration

The file `.env` holds the configuration and the two tokens. Git ignores it. Its mode is 600. `.env.example` shows the format.

| Variable | Function |
|---|---|
| `MEMO_OWNER` | The name of the person who owns the queue, for example `sam`. The default is `owner`. Agents send memos to this name, and the examples below use `owner`. |
| `HOST`, `PORT` | The interface and the port. The defaults are `127.0.0.1` and `3280`. |
| `DATABASE_PATH` | The SQLite file. The default is `./data/memo.db`. |
| `MEMO_TOKEN` | The token of the owner and of the agent `main`. It can do all operations. |
| `MEMO_LIAISON_TOKEN` | The token of the liaison run. It can only read the memos to `liaison`, send a memo to the owner, close a memo to `liaison`, mark its own results as read, set its own status line, and forward a Discord message that the owner wrote (one time for each message). |

To copy the token for a page (macOS), run `sed -n 's/^MEMO_TOKEN=//p' .env | tr -d '\n' | pbcopy` in the directory of this repository.

## The Inbox

Open `http://127.0.0.1:3280/inbox`. Paste the token one time. The browser keeps it.

### The pages on a phone, with no token

A browser keeps the token for one address only. With [Tailscale Serve](https://tailscale.com/kb/1312/serve), the pages can work on your other devices with no token:

1. Run `tailscale serve --bg --https=8443 http://127.0.0.1:3280`.
2. In `.env`, set `MEMO_TAILSCALE_LOGIN` to the login name of your Tailscale account.
3. In `.env`, set `MEMO_TAILSCALE_HOST` to the host name and port from step 1, for example `your-mac.your-tailnet.ts.net:8443`.
4. Start the server again.

Tailscale Serve tells the server which tailnet user sent a request. The server gives full access with no token only when that user is `MEMO_TAILSCALE_LOGIN`, the request came to `MEMO_TAILSCALE_HOST`, and the request is not from a page of a different site. `HOST` must stay `127.0.0.1`. A program that runs on the computer of the server can make such a request without Tailscale, so this setting gives no protection against a local program (a local program with your user account can read `.env` also).

The Inbox shows the open memos to the owner. The order is:

1. Memos with a due date in the next 2 days, or an earlier due date. The earliest date goes first.
2. All other memos by score, highest first. The score is the impact (1 to 5) divided by the weight of the effort.
3. With equal scores, the older memo goes first.

| Effort | Time of the owner | Weight |
|---|---|---|
| `micro` | Less than 2 minutes | 1 |
| `short` | 2 to 15 minutes | 2 |
| `hour` | 15 to 60 minutes | 3 |
| `half-day` | 1 to 4 hours | 5 |
| `day` | More than 4 hours | 8 |

The weights and the 2-day limit are in `src/rank.js`. `impact.md` tells the agents how to select the two values.

A memo that the owner did not see has the tag "new". A memo whose text changed after the owner saw it has the tag "updated". The tag goes away when the memo was on the screen for 2 seconds, and the server records this, so it is the same on each device.

A memo with a tag that is not on the screen gets a toast in the corner of the page, with its first line. Select the toast to go to the memo. The toast goes away when you saw the memo or closed the toast. The page shows 3 toasts at most.

A list item that starts with `[ ]` or `[x]` (for example `- [ ] Rain jacket`) shows as a check box. The owner can tick it on the Inbox page. The server saves the state in the text of the memo, so it is the same on each device, and the agent sees it when it reads the memo.

The buttons "More" and "Less" change the impact of a memo by 1. The server records each change. When an agent sends its next memo, `memo` shows the agent the last 5 changes.

The field at the top sends a memo from the owner to the agent.

The Inbox shows memo text as Markdown (`ui/markdown.js`): headings, lists, tables, quotes, code, bold, italic, links, and images. HTML in a memo stays text.

A block that starts with three backticks and `html` shows in a closed frame, for a chart or a graph. Scripts run in the frame, but the frame cannot read the page, the token, or the API, and it cannot load or send data on a network. The Inbox gives a frame only to memos that are not from `liaison` or `discord`.

An image must be in Memo: `scripts/memo image <path> "<text>"` stores the file in `data/images/` and prints the Markdown line for the memo. The types are PNG, JPEG, GIF, and WebP, with a limit of 5 MB. The page gets the file with the token. An image address on the internet shows as a link, because the pages load nothing from the internet.

## The Agents page

Open `http://127.0.0.1:3280/agents`. Each agent has one row: its state, its status line, and its counts of open memos.

- "Start" starts the session of a long agent in the tmux session `memo-<name>`. To look at it: `tmux attach -t memo-main`. To leave it: Control-b, then d.
- "Stop" asks the agent for a recap, then ends the session. If no recap arrives in 3 minutes, the session ends with no recap. "Stop now" ends the session immediately.
- The next session of the agent gets the recap after its charter.
- The server remembers which agents the owner started. It starts them again when it starts.

The agents are in `agents.json`. To add an agent, add an entry and a file `charters/<name>.md`, then restart the server.

## An agent on a different computer

A remote agent has its session on a different computer from the server. Use it when the server is always on (for example in the cloud) and some work needs a computer that is not always on.

On the server:

1. Add the agent to `agents.json` with the kind `remote`, for example `{ "name": "mac", "kind": "remote" }`.
2. Add its charter, `charters/mac.md`.
3. Start the server again.

On the computer of the agent:

1. Get this repository. No server runs there.
2. Make `.env` with `MEMO_URL` (the address of the server) and `MEMO_TOKEN`, then run `chmod 600 .env`.
3. Add the agent to `local/agents.json` with its `dir` and `model`, for example `{ "name": "mac", "kind": "remote", "dir": "~", "model": "claude-opus-5-5" }`.
4. Run `scripts/remote-agent.sh mac`, or use the LaunchAgent `launchd/memo.remote.plist.example`.

The script starts the session of the agent in the tmux session `memo-mac` when the server answers. Memos to the agent wait on the server while its computer is offline. The Agents page shows "Online" for 2 minutes after the last request of the agent. The server cannot start or stop the session; stop it on its computer with `tmux kill-session -t memo-mac`.

The remote agent uses `MEMO_TOKEN`, which can do all operations. Give it only to a computer that you trust.

## Your own files: `local/`

The files `agents.json` and `charters/*.md` in the repository are examples. Put your own versions in `local/`, which git ignores:

```sh
mkdir -p local/charters
cp agents.json local/agents.json
cp charters/*.md local/charters/
```

The server and the scripts use a file in `local/` when it exists, and the example when it does not. An optional file `local/agent-settings.json` holds Claude Code settings for the agent sessions, for example `{"deniedMcpServers": [{"serverName": "slack"}]}`. A charter says what an agent can do without a question, so write it with care.

## The command `memo`

```sh
scripts/memo send --from main --to owner --impact 4 --effort micro "Approve the deploy?"
scripts/memo send --from owner --to main "Update the README of the website."
scripts/memo list --to main
scripts/memo reply 12 "Yes."
scripts/memo close 12 "Done."
scripts/memo edit 12 "A new text for an open memo."
scripts/memo ack 12
scripts/memo status --as main "I update the README of the website."
scripts/memo recap --as main "The README is complete. Next: the tests."
scripts/memo wait --as main --hold 12
scripts/memo forward 12
scripts/memo image ~/Desktop/shot.png "The new page"
```

`memo wait` uses no model tokens. It exits with code 0 when a new memo arrives or a memo of the agent gets a result. It exits with code 2 at its time limit.

## Discord

The Discord part is optional. Set the `DISCORD_` variables in `.env` (see `.env.example`), and put the token of your bot in `~/.config/discord-bot-token` with mode 600. A LaunchAgent (`launchd/memo.discord.plist.example`) runs `scripts/discord-watch.py` each 30 seconds. The script sends each new message for your bot as a memo from `discord` to `liaison`, then starts `scripts/run-agent.sh liaison`.

The liaison run has only two commands: `memo` with the restricted token, and the Discord command that `DISCORD_CLI` names. The run cannot send a memo to `main`. For a message that the owner's own Discord account (`DISCORD_OWNER_ID`) wrote, the run can use `memo forward`, which sends the text of that message to `main`.

Logs: `data/discord-watch.log` and `data/liaison-runs.log`.

## Data

The database is `data/memo.db`. Git ignores `data/`. To make a backup, run: `sqlite3 data/memo.db ".backup data/memo-backup.db"`

## Tests

```sh
npm test
```

## Files

| File | Function |
|---|---|
| `src/rank.js` | The queue order. |
| `src/memos.js` | The memo rules. |
| `src/agents.js` | Status, recap, and tmux control of the agents. |
| `src/app.js` | The HTTP routes and the two tokens. |
| `scripts/memo.mjs` | The command-line client. |
| `scripts/agent.sh` | Starts the session of a long agent. |
| `scripts/run-agent.sh` | One short liaison run. |
| `charters/` | Example instructions of the agents. Your own are in `local/charters/`. |
| `local/` | The files of your installation. Git ignores it. |
