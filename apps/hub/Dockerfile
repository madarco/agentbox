# AgentBox hub — self-host / control-box image.
# Build context is the REPO ROOT (the app needs its workspace deps):
#   docker build --network=host -f apps/hub/Dockerfile -t agentbox-hub .
# Or via the bundled compose: `docker compose up` from apps/hub/.
#
# Ships the FULL hub: server.ts (relay daemon + Next UI + resident create worker)
# from the standalone build — the same artifact `agentbox hub` spawns — NOT the
# `next start` [...path] plane. SQLite store (no Postgres container).

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# Build the app's workspace deps (dist/) in dependency order, then assemble the
# spawnable standalone hub (next build + esbuild-bundled server.ts + chunks).
RUN pnpm turbo run build --filter=@agentbox/hub
RUN pnpm --filter @agentbox/hub build:standalone
# The agentbox CLI too: the hub's queue (web-UI creates, queued agent runs) and
# the host-app launchers spawn `node $AGENTBOX_CLI_ENTRY …` — without a built
# CLI the control box can list boxes but never create one from the UI.
RUN pnpm turbo run build --filter=@madarco/agentbox

FROM node:22-slim AS runtime
WORKDIR /repo
RUN corepack enable
# git + openssh-client: the resident create worker clones the repo VPS-side and
# a hetzner box needs ssh/scp on PATH for its ControlMaster.
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Queue worker + host-app spawns re-exec the CLI from this entry.
ENV AGENTBOX_CLI_ENTRY=/repo/apps/cli/dist/index.js
# The standalone hub bundle lives under apps/hub/dist-standalone/**, far from the
# staged runtime tree at apps/cli/runtime, so each provider's own
# findStagedCliRuntimeRoot (which only probes next to its bundle) misses it and
# falls back to hashing packages/** source — a DIFFERENT base fingerprint than
# the CLI baked with, so the hub rejects every PC-baked custody record. Pointing
# AGENTBOX_RUNTIME_ROOT at the staged tree makes the hub compute the same
# fingerprint the CLI does, so shared bake records are recognized as baked.
ENV AGENTBOX_RUNTIME_ROOT=/repo/apps/cli/runtime
# The whole built monorepo: the standalone bundle ships no node_modules, so its
# externals (next, react, pg, better-auth, the cloud SDKs) resolve from the
# workspace node_modules present here. Not size-optimized; fine for a VPS.
COPY --from=build /repo .
EXPOSE 8787
# server.ts self-migrates auth (ensureAuthReady) + the store on boot, so there is
# no separate migrate step. It anchors its own cwd from required-server-files.json.
CMD ["node", "apps/hub/dist-standalone/apps/hub/server.js"]
