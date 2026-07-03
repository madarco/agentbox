# AgentBox hub — self-host image.
# Build context is the REPO ROOT (the app needs its workspace dep @agentbox/relay):
#   docker build -f apps/hub/Dockerfile -t agentbox-hub .
# Or via the bundled compose: `docker compose up` from apps/hub/.

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# Build the app + its workspace deps in dependency order via turbo. The relay
# bundles @agentbox/config / sandbox-core / integrations, so those packages must
# build (emit dist/) before the relay does — `--filter` pulls in `^build` deps.
RUN pnpm turbo run build --filter=@agentbox/hub

FROM node:22-slim AS runtime
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
ENV PORT=3000
# The whole built monorepo (reliable for a pnpm workspace; not size-optimized).
COPY --from=build /repo .
WORKDIR /repo/apps/hub
EXPOSE 3000
# Create/upgrade the auth tables + seed the admin (self-skips when auth is off,
# i.e. no BETTER_AUTH_SECRET), then serve the production build. Runs at boot (not
# build) so it sees the container's POSTGRES_URL + auth env.
CMD ["sh", "-c", "pnpm run db:auth-migrate && pnpm exec next start -p 3000"]
