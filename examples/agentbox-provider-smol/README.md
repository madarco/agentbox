# AgentBox on Smol Machines

This provider runs each AgentBox as a persistent **local Smol microVM**. The
AgentBox box image supplies the same `vscode` user, agent tools, web proxy,
VNC and in-box Docker daemon as the Docker provider. The plugin uses AgentBox's
published provider SDK and Smol's published Node SDK; it does not need a cloud
account or a separate Docker daemon on the host.

## Install from this checkout

```sh
cd examples/agentbox-provider-smol
npm ci
npm run build
agentbox plugin add "$PWD"
```

Then, in your project:

```sh
agentbox create --provider smol
agentbox claude --provider smol
agentbox pause <box>
agentbox start <box>
```

The first create pulls the AgentBox image matching your installed CLI version
from GHCR. Use `--image <OCI ref>` or `AGENTBOX_SMOL_IMAGE=<OCI ref>` if you
run a custom AgentBox image. `--size 4-8-40` requests four vCPUs, eight GiB of
memory, and a 40 GiB disk. Web, VNC, relay and `expose:` service ports are
forwarded to the host; previews use localhost URLs.

The local host needs [Smol's virtualization support](https://github.com/smol-machines/smolvm)
(KVM on Linux, Hypervisor.framework on macOS). The provider transfers workspaces
into VM storage, so `--provider smol` works without sharing a host Docker socket.
The CLI and provider run on the same host: the interactive attach path uses the
local Smol CLI shipped with `smolmachines`.

Checkpoint creation is currently disabled for this plugin: local Smol checkpoint
restore does not yet let a new AgentBox reserve fresh host ports while the source
box remains online. Pause and resume preserve the existing box's RAM and disk.

## Verify

Run `npm run typecheck` and `npm run build`. With working virtualization and
Bun installed, `npm run test:e2e` provisions the published AgentBox image and
checks file transfer, preview routing, stop/start, pause/resume and cleanup on
a real VM.
