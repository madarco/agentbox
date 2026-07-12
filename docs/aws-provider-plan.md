# AWS EC2 provider — implementation plan

Status: **in progress.** Live progress is tracked in [`aws_backlog.md`](./aws_backlog.md).

## Context

AgentBox runs each box on a pluggable provider. Before this work there were six: `docker` (local)
plus `daytona`, `hetzner`, `vercel`, `e2b`, and `digitalocean`. This adds a seventh: **AWS EC2**, so
users can run boxes on their own AWS account.

EC2's primitive is a **VPS reached over an API + SSH** — the same shape as Hetzner and DigitalOcean
(1 instance per box, SSH ControlMaster for all I/O, a per-box firewall locked to the host's egress
IP, snapshot-based checkpoints, and a one-time base-image bake because EC2 cannot build an image
from a Dockerfile). So this is a **clone-and-adapt of `packages/sandbox-digitalocean/`**, not a new
design. See [`cloud-providers.md`](./cloud-providers.md) for the shared model.

## Decisions

| | |
|---|---|
| **Name** | `aws` — package `@agentbox/sandbox-aws`, `--provider aws`, `agentbox aws login`, config keys `box.imageAws` / `box.sizeAws` / `box.awsRegion`, prepared state at `~/.agentbox/aws-prepared.json`. |
| **Auth** | The AWS default credential chain. `agentbox aws login` lists the profiles in `~/.aws/config` and persists `AWS_PROFILE` + `AWS_REGION` to `~/.agentbox/secrets.env`; a second branch pastes static keys. Both resolve through the SDK's node provider chain, so SSO works. |
| **Client** | `@aws-sdk/client-ec2`. The one place we deviate from the dep-free hand-rolled `client.ts` of hetzner/DO — the EC2 Query API is XML-only and SigV4-signed, so hand-rolling buys nothing. |
| **Defaults** | `t3.medium` (2 vCPU / 4 GB, x86_64), `us-east-1`, 40 GB gp3 encrypted root, Ubuntu 24.04 (Canonical). Uses the account's **default VPC** + a public subnet; AgentBox never creates a VPC. `box.awsSubnetId` is the escape hatch and preflight fails loud when there is no default VPC. Only a **per-box security group** is created (SSH from the host's egress IP). |

## Approach

Copy `packages/sandbox-digitalocean/` into `packages/sandbox-aws/`. The provider-neutral machinery
(`ssh-cli`, `ssh-tunnel`, `ssh-key`, `egress-ip`, `poll`, `retry`, `runtime-assets`,
`prepared-state`, `install-box.sh`, `cloud-init`) is reused near-verbatim; the API-facing modules
(`client`, `backend`, `firewall` → `security-group`, `prepare`, `preflight`, `credentials`,
`env-loader`) are rewritten against EC2.

`createCloudProvider()` (`packages/sandbox-cloud/src/cloud-provider.ts`) supplies the entire
`Provider` surface — workspace seeding, relay wiring, ctl launch, attach, checkpoints, Portless.
**We only write a `CloudBackend`** (`packages/core/src/cloud-backend.ts`).

**Take the Hetzner version, not the DO version, of two things** — DO regressed both:
- `repairReachability()` + `firewallNeedsSync()` + the `ensureTunnel` error enrichment. Self-heals a
  stale firewall after the host's egress IP changes; DO has none of it.
- `cloudInitBoxEnv()` — strips `AGENTBOX_RELAY_URL` / `AGENTBOX_RELAY_TOKEN` /
  `AGENTBOX_BRIDGE_TOKEN` before they land in the world-readable 0644 `/etc/agentbox/box.env`. DO's
  naive `startsWith('AGENTBOX_')` filter leaks them.

## What is genuinely EC2-specific

Everything else is a rename. These are the deltas that bite:

1. **`sandboxId` is a string** (`i-0abc…`), not a number. DO/Hetzner `Number.parseInt` it in a dozen
   places — all of those guards go.
2. **The public IP changes across stop/start.** `ensureLiveTarget()` re-reads the IP from the API on
   every call and `stop()` closes the ControlMaster, but the master must additionally be torn down
   when the current IP differs from the one it was opened against. `known_hosts` is per-box with
   `StrictHostKeyChecking=accept-new`, so a new IP just adds an entry.
3. **Firewall = Security Group.** Egress defaults to allow-all (like Hetzner; unlike DO, which needs
   explicit allow-all outbound rules). Create the SG *before* `RunInstances`, pass it as
   `SecurityGroupIds`, record it on the instance tag `agentbox.firewall=<sg-id>`. Sync =
   `RevokeSecurityGroupIngress` + `AuthorizeSecurityGroupIngress`. **`DeleteSecurityGroup` throws
   `DependencyViolation` until the ENI detaches** — terminate, poll until `terminated`, then delete
   with a retry-until-deadline loop (~3 min).
4. **Snapshot = AMI.** `CreateImage({ NoReboot: true })` → poll `DescribeImages` until
   `State === 'available'`. Delete = `DeregisterImage` **plus `DeleteSnapshot` for every EBS snapshot
   in its `BlockDeviceMappings`** — deregistering alone leaks (and bills for) the backing snapshots.
   AMIs are **region-scoped**: record the bake region and fail loud if a create targets another
   region (no auto `CopyImage` in v1).
5. **Base AMI lookup**: `DescribeImages` with `Owners: ['099720109477']` (Canonical) + a
   `ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*` name filter, newest `CreationDate`
   wins. Avoids needing `ssm:GetParameter`.
6. **Prepare connects as `ubuntu`, not `root`** — Canonical AMIs set `disable_root: true`, so the
   install script runs under `sudo`. Boxes then boot from our baked AMI, where `install-box.sh` has
   already created `vscode` and set `AllowUsers vscode`.
7. **Networking**: use the `NetworkInterfaces[0]` form of `RunInstances` with
   `AssociatePublicIpAddress: true`, `SubnetId`, `Groups: [sgId]` — that form cannot be mixed with
   top-level `SubnetId` / `SecurityGroupIds`.
8. **Root volume**: explicit `BlockDeviceMappings` (`/dev/sda1`, gp3, encrypted,
   `DeleteOnTermination`) — EC2's 8 GB default is far too small. Plus
   `MetadataOptions: { HttpTokens: 'required' }` (IMDSv2).
9. **Preflight** (pure, no-network), fed by `DescribeInstanceTypes` +
   `DescribeInstanceTypeOfferings`: the type exists, is offered in the region, its
   `ProcessorInfo.SupportedArchitectures` **matches the AMI's architecture** (the guard that catches
   a Graviton type against an x86 AMI — Hetzner has the same check for `cax*`), and the root volume
   is at least the AMI's snapshot size.
10. **Error mapping**, keyed on the SDK's stable error `name`: `VcpuLimitExceeded` /
    `InstanceLimitExceeded` → Service Quotas; `InsufficientInstanceCapacity` → another region/type;
    `Unsupported` → type not offered in that AZ; `InvalidAMIID.NotFound` → re-run `prepare`;
    `UnauthorizedOperation` → the missing IAM action; `ExpiredToken` → `aws sso login`. Anything
    unrecognized passes through untouched.
11. **Credential validation with no extra dep**: `DescribeVpcs({ Filters: [{ Name: 'isDefault' }] })`
    proves the credentials work, yields the account id (`OwnerId`) for `login --status`, *and* is the
    default-VPC preflight. No `@aws-sdk/client-sts` needed.

## Guided first-run setup (`agentbox install` → `agentbox aws login`)

`install.ts` drives `providerModule.ensureCredentials()` generically, so the flow lives entirely in
the provider package. Modeled on `packages/sandbox-digitalocean/src/credentials.ts`, extended for
AWS's two branches:

**Branch A — the user already has `~/.aws` (the common case).** Parse the profile names, `select`
one, persist `AWS_PROFILE` + `AWS_REGION`, validate with `DescribeVpcs`. An expired SSO token offers
to run `aws sso login --profile <p>` and retries. **No IAM user, no static keys, nothing created.**

**Branch B — no usable credentials, or a profile missing permissions.**
1. **Diagnose, don't guess.** `preflightPermissions()` dry-runs each API we need. EC2's
   `DryRun: true` returns `DryRunOperation` when allowed and `UnauthorizedOperation` when not,
   creating nothing — so we can report the *exact* missing actions instead of failing opaquely
   twenty minutes into a bake.
2. **Hand over the policy three ways**: write `AGENTBOX_EC2_POLICY` to
   `~/.agentbox/aws/agentbox-ec2-policy.json`, copy it to the clipboard, and offer to open the IAM
   console on the create-policy JSON tab (the console has no prefill parameter, so clipboard + open
   is as close to one-click as AWS allows).
3. **Offer the CLI fast lane**: print `aws iam create-policy` + `attach-*-policy` and run them behind
   a confirm, when the current credentials already have IAM write access.
4. **Default VPC**: an empty `DescribeVpcs(isDefault=true)` — the normal state of a brand-new member
   account — offers `CreateDefaultVpc`, gated by a confirm.

**Explicitly NOT in onboarding**: creating an IAM *user* with long-lived access keys (strictly worse
than the SSO session the user already has, and it would demand `iam:CreateUser` at setup for
privilege we never need at runtime), and creating an AWS Organization or member account (effectively
irreversible — a 90-day close window and a burned root email). Both stay manual and documented.

`doctorChecks()` reuses `preflightPermissions()`, so `agentbox doctor` reports the same missing-action
list without re-running the wizard.

## Phases

| # | Phase | Content |
|---|---|---|
| 0 | Registry row | `PROVIDERS` row + the hand-written `types.ts` fields + `user-config.schema.json`. `packages/config/test/providers.test.ts` is the tripwire. |
| 1 | Package skeleton | client, retry, credentials, setup-iam, env-loader, egress-ip, poll, security-group, prepared-state, preflight, cli, provider-module. |
| 2 | `prepare` | install-box.sh, cloud-init, ssh-*, runtime-assets, stage-runtime, the AMI bake. |
| 3 | `CloudBackend` | `backend.ts` + `index.ts`. |
| 4 | Wiring | loaders, relay, hub, the CLI commands that hardcode provider lists, the shipped skills. |
| 5 | Tests | vitest with a mocked SDK; no live API. |
| 6 | Docs | `cloud-providers.md`, `apps/web/content/docs/aws.mdx`, README, CLAUDE.md + AGENTS.md. |
| 7 | Live e2e | Bake → create → exercise → destroy → prove zero orphans. |

## Verification

`pnpm build && pnpm lint && pnpm typecheck && pnpm test` at the repo root.
`packages/config/test/providers.test.ts` proves the registry/type/schema wiring is complete, and
`Record<ProviderKind, …>` in `apps/cli/src/provider/loaders.ts` makes a missing provider a compile
error.

Phase 7 is the real proof — a VPS provider that has never booted is not done. In particular
**pause/unpause changes the public IP**, which is the highest-risk EC2-specific path, and destroy
must leave no orphan instance, security group, AMI, *or* EBS snapshot.
