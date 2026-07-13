# AWS EC2 provider — build-out status

Live progress tracker for the AWS provider. The design lives in
[`aws-provider-plan.md`](./aws-provider-plan.md); the shared cloud model lives in
[`cloud-providers.md`](./cloud-providers.md).

**Picking this up from the host?** Start at
[`plans/aws-provider-handoff.md`](./plans/aws-provider-handoff.md) — branch, exact commands to create
the AWS account, and the phase-7 e2e + orphan sweep.

**Status: phases 0-7 done. The live e2e ran green on 2026-07-13 against account `AgentBoxMarco`
(`048679570010`, us-east-1) — real EC2 instances, real AMIs, clean teardown. One open bug (the
in-box portless mirror steals port 80 on resume), see below.**

## Live e2e — 2026-07-13, account 048679570010, us-east-1

| Step | Result |
|---|---|
| `aws login` (profile `agentboxmarco`, role-chained off `waldos`) | pass — IAM sweep 8/8 probes, 0 undetermined |
| `prepare --provider aws` | pass — `ami-0dc25c1dfed860f95`, t3.large bake, ~13 min wall-clock; bake instance + prepare SG cleaned up |
| `create --provider aws` | pass — t3.medium, box ready; workspace seeded from tar (`examples/express-ready` is not its own git root) |
| DinD | pass — dockerd 29.1.3, `hello-world` ran, and the `postgres` service ran as a real in-box container |
| `url` / portless | pass on a fresh box — `https://aws-smoke.localhost` → HTTP 200 from the host |
| `aws firewall show` | pass — per-box SG allows tcp/22 from the host egress IP only |
| `checkpoint create` | pass — AMI registered, box stayed live (no-pause) |
| pause → unpause | pass **after two fixes** (below); public IP rotates (18.212.86.50 → 52.201.253.202) and SSH/ControlMaster recovers |
| `destroy` + `checkpoint rm` + `prune` | pass — **no orphans**: no instance, no SG, no volume; the checkpoint AMI *and* its backing EBS snapshot both deleted. Only the base AMI + its one snapshot remain, as intended. |

### Fixed during the e2e

- **IAM dry-run probes never reached the permission check.** The placeholder resource ids were
  all-zero (`i-00000000000000000`); EC2 parses ids *before* evaluating IAM, so 6 of 8 probes died at
  `Invalid<X>ID.Malformed` and were reported "undetermined". The sweep was only really testing the
  two actions that take no resource id — it would have said "IAM permissions OK" to a scoped policy
  that could not launch an instance. Every 17-char id is rejected as malformed (even well-formed
  hex); the legacy 8-char form parses and reaches evaluation. `Invalid<X>ID.NotFound` ⇒ authorized.
- **`pause` returned before the instance reached `stopped`.** `StartInstances` is rejected out of
  `stopping`, so an immediate `unpause` failed. The knock-on was worse: the failed unpause left a
  stale ControlMaster, the retry's `previewUrl()` threw, `reEnsureCloudBox` swallowed it in a bare
  `catch`, and the box came back on cached `ssh -L` ports nothing listened on — healthy box, 502 URL.
  `stop()` now waits for `stopped`, and that catch logs instead of hiding a dead URL.

### Open bug — in-box portless mirror steals port 80 on resume

On a **resumed** box the in-box portless mirror binds `:80` and `:443` (one process owns both), which
is the box's `webPort` (from `expose: { as: 80 }`). The host's `ssh -L` forward therefore lands on the
mirror, which 302-redirects to `https://<box>.localhost` — back through the host proxy — instead of
reaching the ctl WebProxy that should serve the app. Net effect: a fresh box serves 200, a resumed box
serves a redirect loop (404). The app itself is fine (`:3000` → 200) and the supervisor reports the
service ready, so nothing else surfaces it.

Not AWS-specific — it lives in the shared cloud resume path (`startInBoxPortless` vs the ctl bootstrap
racing for `:80`), so **hetzner is likely affected too**. The fix is a decision about who owns the
box's `webPort` on a fresh boot; it wasn't taken unilaterally.

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
| 7 | Live end-to-end | done — green 2026-07-13 (see above); 1 open bug (portless :80 on resume) |

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
