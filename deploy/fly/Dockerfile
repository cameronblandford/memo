# Memo with one long agent on a Fly.io Machine. Build from the root of the repository:
#   docker build -f deploy/fly/Dockerfile .
# All data of the installation is on the volume /data. The image holds only the programs.
FROM node:22-bookworm-slim
ENV LANG=C.UTF-8 DISABLE_AUTOUPDATER=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gosu jq less openssh-client procps python3 ripgrep sqlite3 tmux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscaled /usr/local/bin/tailscale /usr/local/bin/
# gosu sets HOME from the user record, so the home directory of the agent user is on the volume.
RUN usermod -d /data/home node && npm install -g @anthropic-ai/claude-code && npm cache clean --force
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN install -m 755 deploy/fly/entrypoint.sh /usr/local/bin/memo-entrypoint \
    && install -m 755 deploy/fly/as-agent.sh /usr/local/bin/as-agent
ENTRYPOINT ["memo-entrypoint"]
