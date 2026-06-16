# AgentBox hosted control plane — self-host image.
# Build context is the REPO ROOT (the app needs its workspace dep @agentbox/relay):
#   docker build -f apps/control-plane/Dockerfile -t agentbox-control-plane .
# Or via the bundled compose: `docker compose up` from apps/control-plane/.

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# Build the app + its workspace deps in dependency order via turbo. The relay
# bundles @agentbox/config / sandbox-core / integrations, so those packages must
# build (emit dist/) before the relay does — `--filter` pulls in `^build` deps.
RUN pnpm turbo run build --filter=@agentbox/control-plane

FROM node:22-slim AS runtime
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
ENV PORT=3000
# The whole built monorepo (reliable for a pnpm workspace; not size-optimized).
COPY --from=build /repo .
WORKDIR /repo/apps/control-plane
EXPOSE 3000
# next start serves the production build; the route handlers run on Node.
CMD ["pnpm", "exec", "next", "start", "-p", "3000"]
