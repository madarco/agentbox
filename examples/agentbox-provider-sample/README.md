# agentbox-provider-sample

A minimal **reference** AgentBox provider plugin, built only on
[`@madarco/agentbox-provider-sdk`](../../packages/provider-sdk). The backend is a stub (it
does not provision real boxes) — its job is to show the smallest thing that plugs
in end-to-end: implement a `CloudBackend`, wrap it with `createCloudProvider`, and
export a `providerModule`.

See [`docs/provider-plugins.md`](../../docs/provider-plugins.md) for the full
authoring guide.

## Try it

```bash
# build against the published SDK (or a local `npm pack` of packages/provider-sdk)
npm install
npm run build

# register it with your AgentBox CLI and see it appear
agentbox plugin add .
agentbox plugin list
agentbox doctor            # shows a `sample:` group
agentbox plugin remove sample
```

`agentbox create --provider sample` is recognized but fails at provision — the
backend is intentionally a stub. Replace `sampleBackend` with real cloud SDK calls
to make it a working provider.
