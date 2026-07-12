# AWS EC2 provider — build-out status

Live progress tracker for the AWS provider. The design lives in
[`aws-provider-plan.md`](./aws-provider-plan.md); the shared cloud model lives in
[`cloud-providers.md`](./cloud-providers.md).

**Status: Phase 0 done. Phases 1-6 in progress. Phase 7 (live e2e) blocked on an AWS account.**

## Phases

| # | Phase | Status |
|---|---|---|
| 0 | Registry row (`PROVIDERS`, `types.ts`, `user-config.schema.json`) | done |
| 1 | Package skeleton (client, credentials, setup-iam, security-group, preflight) | done |
| 2 | `prepare` — the AMI bake | done |
| 3 | The `CloudBackend` | todo |
| 4 | Wiring (loaders, relay, hub, CLI commands, shipped skills) | todo |
| 5 | Unit tests (mocked SDK) | todo |
| 6 | Docs | todo |
| 7 | Live end-to-end | blocked — needs an AWS account |

## Phase 0 — done

- `packages/config/src/providers.ts` — the `{ name: 'aws', kind: 'cloud', … }` row. Derives
  `ProviderKind`, `PROVIDER_NAMES`, `CLOUD_PROVIDER_NAMES`, the `box.provider` enum, the generated
  `box.imageAws` / `box.sizeAws` / `box.defaultCheckpointAws` KEY_REGISTRY entries, the
  install-wizard picker, and the fork / checkpoint / doctor provider lists.
- `packages/config/src/types.ts` — the four hand-written spots (`UserConfig.box`,
  `EffectiveConfig.box`, `BUILT_IN_DEFAULTS.box`, and KEY_REGISTRY entries for the three AWS-only
  keys).
- `packages/config/schema/user-config.schema.json` — the six new keys (`additionalProperties: false`,
  so a missing key would invalidate any config that sets it).
- `agentbox.yaml` — carry entries for AWS credentials + the `aws-prepared.json` pointer, and an
  `aws-cli` task that installs AWS CLI v2 in-box. See "Dogfooding" below.

New config keys:

| Key | Default | Meaning |
|---|---|---|
| `box.imageAws` | `''` | AMI id. Written by `agentbox prepare --provider aws`. |
| `box.sizeAws` | `''` | EC2 instance type (e.g. `t3.medium`). |
| `box.defaultCheckpointAws` | `''` | Per-provider default checkpoint. |
| `box.awsRegion` | `us-east-1` | Region for new boxes. Overridable with `--location`. |
| `box.awsSubnetId` | `''` | Explicit subnet; empty = a public subnet of the default VPC. |
| `box.awsDiskGb` | `40` | Root EBS volume size (EC2's own 8 GB default is too small). |

## The bake logs in as root, not `ubuntu` (found during phase 2)

`install-box.sh` renames whatever account owns UID 1000 to `vscode` so the image
matches the docker provider's layout. On a Canonical AMI that account is **`ubuntu`** — and
`usermod -l` refuses to rename an account that has running processes. Had the bake ssh'd in as
`ubuntu` (the obvious choice, and what the original plan said), our own login shell would have
blocked the rename and the bake would have failed.

So the prepare instance is reached as `root`. That is fiddlier on EC2 than on hetzner/digitalocean,
whose stock images make `root` the *default* cloud-init user — a top-level `ssh_authorized_keys:`
lands there. On EC2 the default user is `ubuntu`, so the same block injects the key for the wrong
account. `generatePrepareCloudInit` therefore writes `/root/.ssh/authorized_keys` explicitly from
`runcmd`, which runs last and overwrites whatever cloud-init's own ssh module put there (including
the `disable_root` forced-command banner). Ubuntu ships `PermitRootLogin prohibit-password`, so
key-based root login works once the key is in place.

## Dogfooding (developing the provider inside a box)

`agentbox.yaml` carries a **dedicated** `~/.aws/agentbox-config` + `~/.aws/agentbox-credentials`
pair onto the box's canonical `~/.aws/config` + `~/.aws/credentials`, rather than the host's real
`~/.aws`. The real files hold every profile on the host — including an org's management account —
and carrying them would hand an in-box agent the keys to all of them. Scope the carried pair to one
throwaway AWS account and the box's blast radius is exactly that account.

SSO profiles are **not** carryable: their tokens live in `~/.aws/sso/cache` and only a browser
`aws sso login` refreshes them. The in-box path therefore needs static keys from the isolated
account (the same trade-off the Vercel CLI store has).

The AWS CLI is **not** in the box image — the provider talks to EC2 through `@aws-sdk/client-ec2`,
so the CLI is only needed for the dev loop (exercising the `aws sso login` / `aws iam create-policy`
shell-outs, and sweeping for orphan resources after a live e2e). The `aws-cli` task installs it
in-box on demand, gated on a carried `~/.aws/config`, so a box doing non-AWS work downloads nothing.

## Deferred

- **Cross-region AMI copy.** AMIs are region-scoped; v1 pins boxes to the region the base AMI was
  baked in and fails loud otherwise. `CopyImage` would lift that.
- **Elastic IP.** Would keep a box's public IP stable across stop/start (today the IP changes and the
  SSH ControlMaster is re-established against the new one). Costs money while allocated.
- **True zero-cost pause.** Like Hetzner/DO, a stopped EC2 instance still bills for its EBS volume.
  The real fix is snapshot-and-delete, respawn on resume.
- **Spot instances.** Much cheaper, but an interruption kills the box.
- **Per-project snapshot tier.** Same as the Hetzner/DO story: this *is*
  `checkpoint create --set-default` + `box.defaultCheckpointAws`, not a separate feature.
