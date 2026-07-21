# @madarco/agentbox-provider-sdk

The public, semver'd SDK for building an [AgentBox](https://github.com/madarco/agentbox)
sandbox **provider** as an installable package. A provider plugin lets `agentbox
--provider <name>` run coding agents on your own cloud/infra — with **zero edits to
AgentBox itself**.

This is the *only* AgentBox dependency a plugin needs: it re-exports the whole
provider-facing surface (`Provider`, `CloudBackend`, `ProviderModule`,
`createCloudProvider`, doctor + prepared-state + attach + checkpoint helpers,
`resolveSharedRuntimeAsset`, …) with AgentBox's private internals inlined, so a
plugin never imports `@agentbox/*` internals directly. That indirection is the
stable seam that lets AgentBox refactor without breaking published plugins.

## Install

```bash
npm install @madarco/agentbox-provider-sdk
```

## The shape of a provider plugin

Implement the thin `CloudBackend` (~13 methods over your cloud's SDK), wrap it with
`createCloudProvider` to get the full box lifecycle for free, and export a
`providerModule`:

```ts
import {
  createCloudProvider,
  type CloudBackend,
  type ProviderModule,
} from '@madarco/agentbox-provider-sdk';

const backend: CloudBackend = {
  name: 'myprovider',
  async provision(req) {
    /* create the VM/sandbox, return { sandboxId } */
  },
  async get(id) {
    /* … */
  },
  async start(h) {}, async stop(h) {}, async pause(h) {}, async resume(h) {},
  async destroy(h) {}, async state(h) { return 'running'; },
  async exec(h, cmd, opts) {
    /* … */
  },
  async uploadFile(h, local, remote) {}, async downloadFile(h, remote, local) {},
  async listFiles(h, dir) { return []; },
  async previewUrl(h, port) { return { url: `https://…:${port}` }; },
  // optional: createSnapshot/deleteSnapshot (checkpoints), list (prune),
  // refreshPreviewUrl, signedPreviewUrl, attachArgv, renewTimeout, …
};

const provider = createCloudProvider(backend, {
  defaultResources: { cpu: 2, memory: 4, disk: 40 },
});

export const providerModule: ProviderModule = {
  provider,
  doctorChecks: async () => [{ label: 'credentials', status: 'ok', detail: 'configured' }],
  // optional: backend, ensureCredentials, readCredStatus, currentBaseFingerprintLive
};
```

Only `provider` and `doctorChecks` are required — `createCloudProvider` supplies
the entire lifecycle (workspace seeding, ctl launch, relay wiring, preview URLs,
checkpoints, cp) on top of the thin `CloudBackend`. "A cloud is one file."

## Package requirements

- Name it `agentbox-provider-<name>` (or `@scope/agentbox-provider-<name>`).
- Declare the contract version in `package.json`:
  ```json
  { "agentbox": { "providerApiVersion": 1 } }
  ```
- Export a `providerModule` (or `providerModules` for a multi-provider package).

The CLI loads a plugin only if its `providerApiVersion` is in the CLI's supported
set — the exported `SDK_API_VERSION` is the compatibility gate (bumped on any
breaking change to `Provider` / `CloudBackend` / `ProviderModule`).

## Operating a plugin

```bash
npm i -g agentbox-provider-myprovider
agentbox plugin add agentbox-provider-myprovider   # validates + records it (a path also works)
agentbox doctor                                    # shows your provider's group
agentbox create --provider myprovider              # first create triggers ensureCredentials
```

A provider plugin runs **in-process** with full host + credential access — it is
trusted code, exactly like the CLI. `agentbox plugin add` is the consent boundary.

## Learn more

- **Authoring guide:** [`docs/provider-plugins.md`](https://github.com/madarco/agentbox/blob/main/docs/provider-plugins.md)
- **Minimal reference (stub):** [`examples/agentbox-provider-sample`](https://github.com/madarco/agentbox/tree/main/examples/agentbox-provider-sample)
- **Real, working reference (Vercel-backed):** [`examples/agentbox-provider-example`](https://github.com/madarco/agentbox/tree/main/examples/agentbox-provider-example)

## License

MIT
