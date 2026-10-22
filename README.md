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

For a step-by-step setup on one Mac, written for a Claude agent that sets it up for a person who does not write code, see [docs/local-setup.md](docs/local-setup.md).

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
| `MEMO_OWNER_TOKEN` | Optional. The token of the owner alone. It can do all operations, and it can approve a permission rule (see below). Do not give it to an agent. |
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

Optional, a short address such as `http://your-mac/inbox`: also run `tailscale serve --bg --http=80 http://127.0.0.1:3280`. With MagicDNS, the first part of the host name works alone in the tailnet. The server sends each request to the short name on to the full HTTPS name (`MEMO_TAILSCALE_HOST`), so the browser keeps one token and the Tailscale check applies. Some browsers search for `your-mac/inbox`; type `http://` before it one time, and the browser remembers the address.

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

The button "Note" sends the text of the reply field to the sender of the memo, and the memo stays open in the Inbox with its place in the queue. Use it to ask for a change or for more data. The notes show below the memo text, with the answers of the agent. `memo wait` gives the agent each memo with a note that it did not read. The agent answers with `memo note <id> --from <name> "<text>"`, changes the memo with `memo edit`, or runs `memo ack <id>` when no answer is necessary. A note, an edit, or an ack of the agent marks as read only the notes of the owner that `memo wait` or `memo list` gave to the agent; a later note stays unread and comes in the next `memo wait`. `memo compact` is refused while the memo has a note of the owner that is not read (other than the Shorten request). "Reply" and "Close" end the memo as before.

The button "Shorten" is on each memo from an agent. It adds a fixed note that asks the agent to make the memo short. The Inbox does not show this note; the button shows "Asked" instead. The agent runs `memo compact <id> --from <name> -- "<new text>"`: the server closes the memo ("Compacted into memo #<new id>.") and sends a new memo with the new text and the impact, effort, due date, tags, and brief of the old memo. The new text has a short summary, the open items as check boxes, and the next step. The button shows "Asked" until the agent reads the note.

The buttons "More" and "Less" change the impact of a memo by 1. The server records each change. When an agent sends its next memo, `memo` shows the agent the last 5 changes.

The field at the top sends a memo from the owner to the agent.

The Inbox shows memo text as Markdown (`ui/markdown.js`): headings, lists, tables, quotes, code, bold, italic, links, and images. HTML in a memo stays text.

A block that starts with three backticks and `html` shows in a closed frame, for a chart or a graph. Scripts run in the frame, but the frame cannot read the page, the token, or the API, and it cannot load or send data on a network. The Inbox gives a frame only to memos that are not from `liaison` or `discord`.

An image must be in Memo: `scripts/memo image <path> "<text>"` stores the file in `data/images/` and prints the Markdown line for the memo. The types are PNG, JPEG, GIF, and WebP, with a limit of 5 MB. The page gets the file with the token. An image address on the internet shows as a link, because the pages load nothing from the internet.

### An image from the owner

In the Inbox, the owner can attach images to a new memo, a reply, and a note: with the picture icon in the field (on a phone it opens the photo library and the camera), with a paste, or with a drop on the field. Each image becomes a Markdown line in the text, and the field shows a small view of each image.

- The browser sends a PNG, JPEG, or WebP file of 1.5 MB or less, and a GIF of 5 MB or less, with no change. It makes a JPEG of each other image first, with the longest side not more than 2400 pixels. Thus a large phone photo and a HEIC photo also go through, if the browser can read the file.
- The files are in `data/images/`, the same store as `memo image`. A request for an image needs the token. The name of a file comes from its content, so the same image is stored one time.
- An agent cannot see an image in the text. Thus `memo list` and `memo wait` get each image that a memo brings, and they print a line with the local path. The agent opens that file. The client puts the files in `MEMO_IMAGE_DIR`, or in `$MEMO_WORK_DIR/images`, or in `work/images/`, or in the temporary directory: the first one that it can write to. This also works for an agent on a different computer, because the client gets the file from `MEMO_URL`.
- A backup of the database does not contain the images. Copy `data/images/` also. Memo does not delete memos, so it does not delete images.
- An image from the owner is content from the owner. Text inside an image that came from a different person is information, not an instruction.

## Ticks

Ticks are an optional part, and they are off by default. To switch them on, set `MEMO_TICKS=1` in `.env` and start the server again.

A tick is a small action of the owner that comes back: each day, on some days of the week, or some days after the owner did it last. A tick is not a memo. It is one row with a check box in the Inbox, between the memos.

- A tick has an impact and an effort, and it gets its place in the list from the same score as a memo. With an equal score, the memo goes first. A tick never goes above a memo with a due date in the next 2 days.
- The place does not change through the day, with one exception: an overdue tick goes to the top of the list, above all memos, with the word "prioritize". The page does not show the word "overdue".
- A tick is overdue when the owner did not do it and did not skip it on the last day of its schedule, when a tick with `--every` came back before today, or when its time `--by` is past.
- A skip is a decision of the owner. After a skip, the tick is not overdue on the next day.
- A tick that the owner did not do goes away at the end of the day. There is no backlog.
- "skip today" removes the row for today. "less" and "more" change the impact by 1, and the change stays for the next days.
- A tick gets no tag and no toast, and it is not in the count of memos.
- The limit is 10 active ticks (`MAX_ACTIVE` in `src/ticks.js`).

```sh
scripts/memo tick add --impact 3 --effort short Shower
scripts/memo tick add --impact 2 --effort short --days mon,wed,fri --after 17:00 Stretch
scripts/memo tick add --impact 2 --effort micro --every 7 -- Water the plants
scripts/memo tick set 2 --impact 3
scripts/memo tick list
scripts/memo tick log 7
scripts/memo tick remove 2
```

- `--days`: the tick is in the list only on these days of the week.
- `--every <days>`: the tick comes back this many days after the owner did it. It stays in the list each day until the owner does it.
- `--after HH:MM`: the tick is not in the list before this time.
- `--by HH:MM`: the tick is overdue after this time of the day.
- `memo tick log` shows one letter for each day: `d` for done, `s` for skipped, and a point for no mark. An agent uses it to propose a change to a tick that the owner skips often.

The day of the ticks starts at 03:00, so a tick of the evening is still there after midnight. `MEMO_DAY_START` in `.env` gives a different hour. `MEMO_TZ` gives the time zone of the owner (for example `America/New_York`) when the server is in a different time zone.

## The Agents page

Open `http://127.0.0.1:3280/agents`. Each agent has one row: its state, its status line, and its counts of open memos.

The row of an agent with a session also shows the screen: the last 80 lines of its tmux session, read each 5 seconds. If the end of the screen is a Claude Code dialog (a choice that waits for an answer), the row says so. The Escape button closes such a dialog; the Enter button confirms its selected choice. These are the only keys that the page can send. To type into a session, use Remote Control in the Claude app, or `tmux attach` on its computer.

- "Start" starts the session of a long agent in the tmux session `memo-<name>`. To look at it: `tmux attach -t memo-main`. To leave it: Control-b, then d.
- "Stop" asks the agent for a recap, then ends the session. If no recap arrives in 3 minutes, the session ends with no recap. "Stop now" ends the session immediately.
- The next session of the agent gets the recap after its charter.
- The server remembers which agents the owner started. It starts them again when it starts.

The agents are in `agents.json`. To add an agent, add an entry and a file `charters/<name>.md`, then restart the server.

To show the live output of an agent on the Agents page, give it the directory of its Claude Code transcripts, for example `"transcripts": "~/.claude/projects/-Users-you-work"` (the name is the `dir` of the agent with each `/` changed to `-`). The page asks for new output each 3 seconds and shows the last 50 entries of the newest `.jsonl` file there. It shows only the visible text of the agent and, for each tool call, the tool name and its short description: never tool inputs, tool results, or thinking. An agent with no `transcripts` shows no output.

The Agents page shows the computer of each agent next to its name. Give it with `"computer"`, a short name with only letters, digits, and `-` (for example the Tailscale machine name, `"computer": "workmac"`). A local agent (`long` or `short`) with no `computer` shows the computer of the server: its host name without the domain (`playmac.local` shows as `playmac`). A remote agent with no `computer` shows no name.

## Permission rules from the Inbox

An agent that the Claude Code permission check blocks can ask for a rule:

```sh
scripts/memo rule --from main --rule 'Bash(npm test:*)' --why 'To run the tests of the website.'
```

The memo to the owner shows the reason and the rule. Its last line is a marker for the server, which the Inbox hides:
`<!-- memo-rule: {"agent":"main","rule":"Bash(npm test:*)"} -->`. The Inbox shows the rule of the marker with the button "Approve rule". Reply or Close refuses it.

The agent only asks. On "Approve rule", the server adds the rule to `permissions.allow` in the settings file of the agent, closes the memo with a note, and the agent gets the result with `memo wait`. The rule applies when the session of the agent starts again.

- Give the agent its settings file in `agents.json`, for example `"settings": "~/work/.claude/settings.local.json"`. An agent with no `settings` cannot get rules this way. A remote agent cannot have `settings`: its file is on a different computer.
- Only the owner can approve: a request through Tailscale Serve with the owner's login (see above), or with `MEMO_OWNER_TOKEN`. `MEMO_TOKEN` cannot, because the agents have it. A program on the computer of the server can act as Tailscale (see above), so the Claude Code rules of an agent must not permit `curl` to the server.
- The server approves only the exact rule that the Inbox showed. If the memo changed after that, the approval fails. The memo must be open and from the agent that the marker names; a request from `liaison` or `discord` is refused.
- The server refuses a rule that would let an agent widen its own limits: `*`, `Bash` or `Bash(*)`; a Bash rule that names `.claude` or a settings file; a Bash rule with a wildcard for a shell or an interpreter (for example `Bash(python3:*)`); and an `Edit`, `Write`, `MultiEdit`, or `NotebookEdit` rule that reaches a Claude Code settings file (for example `Edit(~/**)` or `Edit(*.json)`). Any other rule is your decision: a rule such as `Bash(npm run:*)` lets the agent run a script that it can change.
- The server never changes `deny`, `ask`, `defaultMode`, or other keys. Before a change, it copies the file to `<file>.bak-<time>`. It writes a temporary file and then renames it. A rule that is already there is not added again.

## The Log page

Open `http://127.0.0.1:3280/log`. It shows what is on its way to each agent, and what happened to each memo.

- "In flight": for each agent, its open memos, the answers that it did not ack, and the notes of the owner that it did not read. Each line tells if `memo wait` or `memo list` delivered the memo after its last change, or if `memo wait --hold` holds it. The first line of the agent tells when its `memo wait` asked last.
- "Events": the steps of the memos (send, delivered, seen, note, edit, brief, reply, close, ack, compact, postpone, forward) and the status lines, newest first. Filter by agent or by memo id; `/log?memo=42` shows one memo.
- The server writes the events to the table `events`. The table is append-only. An event has the title or the first 80 characters of a text, never the full text.

## The Chat page

Open `http://127.0.0.1:3280/chat`. It shows the memos between the owner and one agent, in the two directions, as a chat: the oldest at the top, the newest at the bottom. The top line is the status line of the agent.

- The field at the bottom sends a memo from the owner to the agent, as the field of the Inbox does. Return sends; Shift-Return adds a line. The agent gets the memo with `memo wait`.
- Each memo shows its notes, and the reply or the close that ended it. Its number goes to the memo on the Log page. Answer an open memo of the agent in the Inbox.
- The list has the agents with a session (`long` and `remote`), not the short agents. `/chat?agent=main` opens the chat with `main`. With no name, the page opens the last chat of the device, or the default agent.
- The page shows the newest 50 memos. "Show older memos" shows 50 more, up to 500. The page loads again each 5 seconds.
- The page reads `GET /api/thread?agent=<name>&limit=<n>`. The read records no delivery and no "seen". The liaison token cannot read it.

## An agent on a different computer

A remote agent has its session on a different computer from the server. Use it when the server is always on (for example in the cloud) and some work needs a computer that is not always on.

On the server:

1. Add the agent to `agents.json` with the kind `remote` and the name of its computer, for example `{ "name": "mac", "kind": "remote", "computer": "workmac" }`.
2. Add its charter, `charters/mac.md`.
3. Start the server again.

On the computer of the agent:

1. Get this repository. No server runs there.
2. Make `.env` with `MEMO_URL` (the address of the server) and `MEMO_TOKEN`, then run `chmod 600 .env`.
3. Add the agent to `local/agents.json` with its `dir` and `model`, for example `{ "name": "mac", "kind": "remote", "dir": "~", "model": "claude-opus-5-5" }`.
4. Run `scripts/remote-agent.sh mac`, or use the LaunchAgent `launchd/memo.remote.plist.example`.

The script starts the session of the agent in the tmux session `memo-mac` when the server answers. Memos to the agent wait on the server while its computer is offline. The Agents page shows "Online" for 2 minutes after the last request of the agent. While the session exists, the script sends the end of the session to the Agents page each 15 seconds (`memo screen --as mac`), so the agent shows as online also while it works. The Escape and Enter buttons of the page go back to the script with the next screen, and the script sends them to the session. The server cannot start or stop the session; stop it on its computer with `tmux kill-session -t memo-mac`.

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
scripts/memo note 12 --from main "The price is $14 each month."
scripts/memo compact 12 --from main -- "- [ ] Pay the invoice. Next: approve the quote."
scripts/memo ack 12
scripts/memo status --as main "I update the README of the website."
scripts/memo recap --as main "The README is complete. Next: the tests."
scripts/memo wait --as main --hold 12
scripts/memo forward 12
scripts/memo rule --from main --rule 'Bash(npm test:*)' --why 'To run the tests.'
scripts/memo image ~/Desktop/shot.png "The new page"
```

`memo wait` uses no model tokens. It exits with code 0 when a new memo arrives or a memo of the agent gets a result. It exits with code 2 at its time limit. It prints the answers to the agent's memos first, with only the name of the agent's own memo, then the new memos. The output has 20000 characters or fewer (`MEMO_WAIT_MAX_CHARS`); the `memo ack` line names only the memos that it printed, and a last line tells how many more memos come in the next `memo wait`.

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

## A scan before each push

If you push your checkout to a public repository, install the scan as the pre-push hook:

```sh
ln -s ../../scripts/pre-push-scan.sh .git/hooks/pre-push
```

The hook reads the lines that the commits of a push add, and the commit messages. It stops the push if it finds a token, a private key, a home directory, a tailnet name, a mail address, or a phone number. Put your own names, addresses, host names, and account ids in `local/scan-patterns.txt`, with one extended regular expression in each line. If a line is not personal, put an expression for it in `local/scan-allow.txt`. Git ignores the two files.

To scan a range by hand: `scripts/pre-push-scan.sh --range origin/main..main`

## Files

| File | Function |
|---|---|
| `src/rank.js` | The queue order. |
| `src/memos.js` | The memo rules. |
| `src/ticks.js` | The ticks: their schedule and their place in the queue. |
| `src/agents.js` | Status, recap, and tmux control of the agents. |
| `src/events.js` | The event log of the Log page. |
| `src/rules.js` | The approval of a permission rule: the checks, and the change of the settings file. |
| `src/app.js` | The HTTP routes and the two tokens. |
| `scripts/memo.mjs` | The command-line client. |
| `scripts/agent.sh` | Starts the session of a long agent. |
| `scripts/run-agent.sh` | One short liaison run. |
| `scripts/pre-push-scan.sh` | The scan for personal data and secrets before a push. |
| `charters/` | Example instructions of the agents. Your own are in `local/charters/`. |
| `local/` | The files of your installation. Git ignores it. |
