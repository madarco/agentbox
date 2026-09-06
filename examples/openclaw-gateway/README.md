# openclaw-gateway — service-agent smoke fixture

The smallest workspace that exercises an agent whose surface is a **service**
rather than a TUI. `agentbox openclaw` creates the box, installs openclaw on
demand, runs its onboard + config render, starts the gateway, and prints the URL
and the gateway token — there is nothing to attach to.

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
