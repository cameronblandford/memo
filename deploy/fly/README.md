# Memo on Fly.io

These files run the Memo server and one long agent on one Fly.io Machine. Use them when the computer that
usually runs Memo is off.

> **Warning.** The agent runs Claude Code on the Machine with your Claude account. The Machine holds your
> memos, your Memo token, and your Claude sign-in. Read the charter of the agent before you start it.

| File | Function |
|---|---|
| `Dockerfile` | The image: Node 22, Claude Code, tmux, git, and Tailscale. |
| `entrypoint.sh` | Starts Tailscale, the optional Discord watcher, then the Memo server as the user `node`. |
| `as-agent.sh` | Runs a command as the agent user. In the Machine its name is `as-agent`. |
| `fly.toml.example` | The configuration of the app. |

## How it works

- The Machine has no public address. Tailscale Serve is the only way to the pages.
- The volume `/data` holds all data: `memo/` (the database and the images), `home/` (the home directory of the
  agent, with the Claude Code sign-in), `local/` (your `agents.json` and charters), and `tailscale/`.
- A deploy replaces the image. The volume stays.
- The image contains no file of your installation. `.dockerignore` keeps `.env`, `data/`, `work/`, and `local/` out.

## Set up

1. Copy `deploy/fly/fly.toml.example` to `fly.toml` in the root of the repository.
2. Set `app` and `MEMO_OWNER` in `fly.toml`.
3. Run `fly apps create <app>`.
4. Run `fly secrets set --stage MEMO_TOKEN=<token>`. Use a new token, not a token of a different installation.
5. Run `fly deploy --ha=false`. Fly makes the volume from `[mounts]`.
6. Run `fly ssh console`, then `tailscale up --hostname=memo`. Open the link that it prints and approve the device.
7. Run `tailscale status`. Write down the name of the Machine, for example `memo.your-tailnet.ts.net`.
8. In `fly.toml`, set `MEMO_TAILSCALE_LOGIN` and `MEMO_TAILSCALE_HOST`. Run `fly deploy` again.

The device stays in the tailnet, because its state is on the volume. As an alternative to step 6, set the secret
`TS_AUTHKEY` to an auth key from the Tailscale admin console before step 5, and remove the secret after the first start.

## Your agents and charters

Put your `agents.json` and `charters/` in `/data/local/` on the Machine. Without them, the examples of the
repository apply. To copy a file: `fly ssh sftp shell`, then `put local/agents.json /data/local/agents.json`.
The `dir` of an agent must be in the home directory, for example `~/work`.

## Sign in to Claude Code (one time)

1. Run `fly ssh console`.
2. Run `as-agent claude`.
3. Do the sign-in steps that Claude Code shows. Accept the work directory.
4. Type `/exit`.

Then open the Agents page (`https://<MEMO_TAILSCALE_HOST>/agents`) and select "Start".

To look at the session of the agent: `fly ssh console`, then `as-agent tmux attach -t memo-main`. To leave it:
Control-b, then d.

## Discord (optional)

The entrypoint starts the Discord watcher when the secret `DISCORD_BOT_TOKEN` is set. A loop runs
`scripts/discord-watch.py` each 30 seconds, and continues when a run fails.

1. Put the command that reads and sends Discord messages on the volume, for example `/data/local/bin/discord`.
   It must read the bot token from `~/.config/discord-bot-token`; the entrypoint writes the secret to that file.
2. Add the agent `liaison` (kind `short`) to `/data/local/agents.json`, and put its charter at `/data/local/charters/liaison.md`.
3. Run `fly secrets set --stage` for `DISCORD_BOT_TOKEN`, `MEMO_LIAISON_TOKEN` (a new token), `DISCORD_OWNER_ID`,
   `DISCORD_MAIL_CHANNELS`, and `DISCORD_OWNER_MAIL_CHANNELS`. To keep a value out of the shell history, use `fly secrets import`.
4. Set `DISCORD_CLI` to the path of step 1 in `[env]` of `fly.toml`.
5. Run `fly deploy`.

The state and the logs are in `/data/memo/`: `discord-watch.json`, `discord-watch.log`, and `liaison-runs.log`.
Only one watcher can run for a bot. Stop the watcher on the old computer first, and copy its `data/discord-watch.json`
to `/data/memo/` so that no message is lost or sent two times.

## Move an installation to the Machine

1. Stop the agents and the server on the old computer.
2. Make a copy of the database: `sqlite3 data/memo.db ".backup /tmp/memo.db"`.
3. Stop the server on the Machine, put the copy at `/data/memo/memo.db`, and put `data/images/` at `/data/memo/images/`.
4. Run `chown -R node:node /data/memo` on the Machine, then start it again with `fly machine restart`.

Only one server can use a database. Do not start the server on the old computer while the Machine has the data.

## Test the image on your own computer

```sh
docker build -f deploy/fly/Dockerfile -t memo-fly .
docker run --rm -e MEMO_TOKEN=<16 characters or more> -v memo-test:/data memo-fly
```

With no `TS_AUTHKEY`, Tailscale is not signed in, and the server starts without it.
