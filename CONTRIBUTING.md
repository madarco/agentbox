# Contributing to AgentBox

Thanks for taking the time. Bug reports, docs fixes, and provider work are all welcome.

## Before you start

For anything larger than a bug fix, open an issue first and describe what you want to do. It saves
you from building something that doesn't fit the direction of the project.

If you are adding a new sandbox backend, you probably want a **provider plugin** rather than a
change to this repo — see [Build a provider](https://agent-box.sh/docs/build-a-provider) and
[`docs/provider-plugins.md`](./docs/provider-plugins.md).

## Development

Node 22 and pnpm. [`docs/development.md`](./docs/development.md) has the full loop; the short
version:

```bash
pnpm install
pnpm build
pnpm lint && pnpm typecheck && pnpm test
```

CI runs exactly those checks on every pull request, so run them locally first. Unit tests must stay
pure — no docker, no network. Integration testing is manual for now.

A few conventions worth knowing: TypeScript strict + ESM (`import type` for types), `tsup` per
package, `vitest` for tests, `commander` + `@clack/prompts` for CLI surface, and comments only where
the *why* is non-obvious. [`CLAUDE.md`](./CLAUDE.md) documents the architecture and the house style
in more detail.

If your change adds or alters a CLI command, flag, config key, default, or provider behavior,
update the matching page under [`apps/web/content/docs/`](./apps/web/content/docs) in the same pull
request. Stale public docs are treated as a bug.

## Contributor License Agreement

Before your first pull request can be merged, you need to accept the
[Contributor License Agreement](./.github/CLA.md). A bot will comment on the pull request with a
one-line sentence to post as a reply; that's the whole process, and it only happens once.

You keep the copyright to your work — the CLA is a license grant, not an assignment. It exists so
the project has a clear, written chain of rights over everything it ships.

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](./SECURITY.md).
