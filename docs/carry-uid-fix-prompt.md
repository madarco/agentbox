# Prompt: carried files land under the wrong uid on e2b / vercel

Paste this as a fresh task. Everything needed to reproduce is here.

---

Carried files (`carry:` in `agentbox.yaml`) are copied into a box owned by **uid
1000**, but the box user is not 1000 on every provider. On e2b and vercel the
agent therefore cannot write a file it was given.

Observed on a live e2b box (2026-08-24):

```
$ agentbox shell <box> -- sh -c 'id -u vscode; stat -c "%u %U" /workspace/backups/testdump.bin'
1001
1000 user
```

The file is mode 0644, so the agent can read it — fine for a database dump you
restore read-only, wrong for anything the agent is meant to edit.

## Root cause

`planCarryEntry` (`packages/sandbox-core/src/sync/concerns/files.ts`, ~line 90):

```ts
// Default uid 1000 (in-box vscode); explicit `user: 0` lands root:root.
const uid = entry.user ?? 1000;
```

The comment states the assumption that makes it wrong: 1000 *is* `vscode` on
docker and hetzner, but the uid varies per provider — docker/hetzner 1000,
vercel 1001, e2b 1002 (and the live box above reported 1001, so treat the exact
numbers as unreliable and resolve at runtime rather than hardcoding a table).

`ResolvedCarryEntry.user` in `packages/core/src/provider.ts` documents the same
assumption and needs the same correction.

## Scope

- **Not** a regression from the carry-to-hub work (PR #308). `applyCarry` is the
  identical code path for a locally-built cloud box, so a local `agentbox e2b
  claude` with a `carry:` block has always done this.
- Affects the cloud sync path: `packages/sandbox-cloud/src/sync/carry.ts` uses
  `plan.uid` to chown after extracting.
- Docker is unaffected in practice (its box user really is 1000), so any fix must
  not change docker behaviour.

## Suggested direction

Chown by **name** (`vscode`, or `id -un`) rather than a numeric default, resolved
in the box, so it is correct wherever the user lands. Keep the explicit
`user: 0` escape hatch working — that one is deliberate and means root:root.

Watch for: the docker path runs some steps as `--user 0:0`, so `$HOME` and the
executing user are not a reliable proxy for the box user; `planCarryEntry` is
pure and host-side, so the name→uid resolution has to happen where the copy is
applied, not in the plan.

## Verification

1. Unit: `planCarryEntry` keeps `user: 0` → root, and no longer bakes 1000 as the
   default.
2. Live, on a provider whose box user is NOT 1000 (e2b or vercel):

```bash
cd /Users/marco/Projects/AgentBox/projects/acme-saas   # already has a carry: fixture
agentbox e2b claude
agentbox shell <box> -- sh -c 'id -u vscode; stat -c "%u %U" /workspace/backups/testdump.bin'
```

The two uids must match. Check the same on a docker box to confirm nothing moved
there.

Note `acme-saas` currently carries an uncommitted test fixture from the #308
verification: `backups/testdump.bin` (3 MB, random), a `backups/` line in
`.gitignore`, and a `carry:` block in `agentbox.yaml`. Reuse it, or recreate with
`head -c 3000000 /dev/urandom > backups/testdump.bin`.
