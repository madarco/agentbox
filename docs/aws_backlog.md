# AWS EC2 provider — build-out status

Live progress tracker for the AWS provider. The design lives in
[`aws-provider-plan.md`](./aws-provider-plan.md); the shared cloud model lives in
[`cloud-providers.md`](./cloud-providers.md).

**Picking this up from the host?** Start at
[`plans/aws-provider-handoff.md`](./plans/aws-provider-handoff.md) — branch, exact commands to create
the AWS account, and the phase-7 e2e + orphan sweep.

**Status: phases 0-6 done (code, tests, docs). Phase 7 (live e2e) blocked on an AWS account — the provider has never booted a real instance.**

## Phases

| # | Phase | Status |
|---|---|---|
| 0 | Registry row (`PROVIDERS`, `types.ts`, `user-config.schema.json`) | done |
| 1 | Package skeleton (client, credentials, setup-iam, security-group, preflight) | done |
| 2 | `prepare` — the AMI bake | done |
| 3 | The `CloudBackend` | done |
| 4 | Wiring (loaders, relay, hub, CLI commands, shipped skills) | done |
| 5 | Unit tests (mocked SDK) | done — 65 tests |
| 6 | Docs | done |
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

```bash
aws sso login --profile agentboxmarco   # host, SSO as usual
pnpm aws:creds                          # -> ./aws_credentials/{config,credentials} (gitignored, 0600)
agentbox claude                         # carry: copies them to the box's ~/.aws/
```

A box **cannot use an SSO profile**: SSO keeps a bearer token in `~/.aws/sso/cache` that the SDK
exchanges for role credentials, and only `aws sso login` — a browser flow — refreshes it. A box has
no browser.

The fix is to carry not the SSO token but the credentials it *resolves to*.
`scripts/export-aws-creds.mjs` (`pnpm aws:creds`) runs `aws configure export-credentials`, which
materializes any profile — SSO, assume-role, static — into a plain key/secret/session-token triple.
So **no long-lived IAM key exists anywhere**: the host keeps SSO, and the box gets an ordinary
short-lived credential file.

It also carries exactly ONE identity. The host's real `~/.aws` holds every profile on the machine,
including an org's management account; carrying that would hand an in-box agent the keys to all of
them. The exported file holds only the isolated dev account, so that is the box's whole blast radius.

**These credentials expire** (an SSO role session is typically 1 hour), and `carry:` copies them in
at CREATE time only — a long-lived box will eventually see `ExpiredToken`. The in-box error message
says so and points back at `pnpm aws:creds` rather than at `aws sso login`, which cannot work there.

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
