# Development

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md).

## Build + verify

```sh
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

## Manual end-to-end

Each long-running CLI command tees its output to `~/.agentbox/logs/<command>.log`
and prints the path on startup. When iterating, **don't block on `agentbox create`
with a long timeout** — start it in the background and tail the log instead
(`tail -f ~/.agentbox/logs/latest.log`). Same for `agentbox claude` / `codex` /
`opencode`. See [CLAUDE.md](../CLAUDE.md) for the full testing/verifying
workflow and the `pnpm drive` harness for interactive TUIs.

A representative loop:

```sh
node apps/cli/dist/index.js create -y -n smoke              # tail logs/latest.log
node apps/cli/dist/index.js checkpoint create smoke --set-default
node apps/cli/dist/index.js claude --host-snapshot -y -n cc -- --model sonnet
# (in tmux) Ctrl+a d to detach; reattach with `agentbox claude attach cc`
node apps/cli/dist/index.js status smoke --inspect
node apps/cli/dist/index.js destroy smoke -y
node apps/cli/dist/index.js destroy cc -y
```

For the full lifecycle command list see [`docs/features.md`](./features.md).

## Image rebuild

The box image is pinned to `agentbox/box:dev` and reused across creates. After
**any** change that bakes into the image, wipe the cached copy so the next
create rebuilds:

```sh
docker rmi agentbox/box:dev
```

`agentbox self-update` does this for you. Anything `COPY`'d in
`packages/sandbox-docker/Dockerfile.box`, or listed as a context file in
`apps/cli/scripts/stage-runtime.mjs`, needs a rebuild — the Dockerfile and the
stage script are the authoritative list.

Wipe everything if state drifts: `agentbox prune --all -y`.

## Host environment assumed

macOS (arm64 tested), Docker via OrbStack or Docker Desktop. Container needs
`--cap-add=SYS_ADMIN --device=/dev/fuse --security-opt=apparmor:unconfined` —
`runBox` in `packages/sandbox-docker/src/docker.ts` is the single source of
truth for those flags.
