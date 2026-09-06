# openclaw-gateway — service-agent smoke fixture

The smallest workspace that exercises an agent whose surface is a **service**
rather than a TUI. `agentbox openclaw` creates the box, installs openclaw on
demand, runs its onboard + config render, starts the gateway, and prints the URL
and the gateway token — there is nothing to attach to.

## Copy it out first

Use this as a **template**, not a working directory. Copy it somewhere with no
`agentbox.yaml` ancestor and, ideally, **no git repo** — that is what an
openclaw workspace actually looks like, and it is the path with the least
coverage:

```bash
cp -R examples/openclaw-gateway ~/Projects/my-gateway
cd ~/Projects/my-gateway            # no .git, no parent agentbox.yaml
agentbox openclaw -y -n claw
```

A repoless workspace is not a lesser fixture, it is a different code path. With
no `.git`, the box is seeded by a tar of the directory rather than a worktree or
clone; `agentbox upload` overlays files and hashes them instead of merging a
branch; and `download` selects with an **exclude list** rather than
`.gitignore`, which the output labels `(exclude-list mode)`. Running the example
in place, inside this repo, exercises none of that.

## Running it in place (smoke only)

```bash
cd examples/openclaw-gateway
node ../../apps/cli/dist/index.js openclaw -y -n claw

node ../../apps/cli/dist/index.js openclaw status claw   # supervisor state
node ../../apps/cli/dist/index.js openclaw url claw      # URL + token
node ../../apps/cli/dist/index.js openclaw logs claw     # gateway log
curl -fsS "$(node ../../apps/cli/dist/index.js openclaw url claw | head -1)/healthz"
```

The box is **persistent** by default — a gateway holding channel connections is
not expendable, so it is never auto-paused or pruned, and `destroy` needs
`--force`. Pass `--no-persistent` to opt out.

## What the `openclaw:` block does

`agentbox-ctl agent render openclaw` applies it through openclaw's own
`config patch --stdin`, sending only the keys that changed since the last
render. So:

- editing a key here and re-rendering updates it in the box;
- editing a DIFFERENT key inside the box with `openclaw config set` survives,
  because AgentBox never asserts a key it was not asked to;
- removing a key here restores openclaw's own default rather than freezing the
  last value AgentBox wrote.

To re-render after editing this file:

```bash
node ../../apps/cli/dist/index.js shell claw -- agentbox-ctl reload
```

## Known gaps

On cloud providers the published URL does not serve yet, and the workspace is
not honoured — see `docs/plans/service-boxes-backlog.md` ("From live cloud
testing on Hetzner"). Docker works end to end.
