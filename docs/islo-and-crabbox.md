# Islo and Crabbox

AgentBox treats Islo as an experimental native cloud provider and Crabbox as a companion tool.

## Islo Provider

Use Islo when you want AgentBox boxes to run on persistent Islo agent computers:

```sh
agentbox islo login
agentbox islo create
agentbox islo claude
```

The provider uses the Islo HTTP API for lifecycle, exec, shares, and snapshots. It maps the local-only `agentbox/box:dev` image sentinel to the published AgentBox image:

```text
ghcr.io/madarco/agentbox/box:latest
```

For interactive attach commands such as `agentbox islo shell` or `agentbox islo claude`, run Islo's SSH setup once:

```sh
islo ssh --setup
```

Optional config:

```yaml
box:
  provider: islo
  sizeIslo: 2-4-20
  isloGatewayProfile: production-apis
```

`sizeIslo` uses `cpu-memory-disk` in GB, with memory converted to MB for Islo.

## Crabbox Companion

Crabbox is not an AgentBox provider. It owns a different workflow: lease remote capacity, sync a dirty checkout, run a command, stream output, collect evidence, and release the target.

That makes Crabbox useful beside AgentBox for remote test/proof runs:

```sh
crabbox run -- pnpm test
```

Do not route AgentBox boxes through Crabbox. AgentBox providers need long-lived box lifecycle, attach, screen/code/browser URLs, checkpoints, workspace seeding, and host relay behavior; Crabbox's Islo path is delegated command execution and does not provide that full box surface.
