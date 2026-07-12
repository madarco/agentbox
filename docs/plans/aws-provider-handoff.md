# AWS EC2 provider — handoff to the host

Session handoff, 2026-07-12. Phases 0-6 of [`../aws-provider-plan.md`](../aws-provider-plan.md)
are **done and committed**. The account phase 7 needed now exists (see below) and the live
end-to-end is in progress on the host.

Live status lives in [`../aws_backlog.md`](../aws_backlog.md). The design lives in
[`../aws-provider-plan.md`](../aws-provider-plan.md). This file is just "how to pick it up from the
host".

## Where the code is

Branch **`agentbox/fork-162032`**, 7 commits. The box's `/workspace` writes into the host's
bind-mounted `.git/`, so these are **already in your host repo** — no push needed:

```bash
git checkout agentbox/fork-162032
git log --oneline -7
```

```
a7f565f37 feat(aws): carry the host's SSO session into a box, no IAM user
5bc70e1d7 docs(aws): public + internal docs for the EC2 provider
ad7e57475 feat(aws): wire the provider into the CLI, relay and hub
2152426d0 feat(aws): the EC2 CloudBackend
9386288f0 feat(aws): prepare — bake the base AMI
07cc60682 feat(aws): package skeleton — EC2 client, credentials, IAM preflight, security group
988ebaa28 feat(aws): register the aws provider + dogfood carry
```

`packages/sandbox-aws` is a new workspace package, so **run `pnpm install` first** — without it the
build fails in the dts step with `Cannot find module '@agentbox/core'` (the package has no
`node_modules` yet). After that, `pnpm build && pnpm test && pnpm lint && pnpm typecheck` are all
green (29 test tasks, 65 of them new in `packages/sandbox-aws`). The CLI resolves `--provider aws`
end to end — `agentbox aws --help`,
`aws login --status`, `doctor --provider aws`, `config list` — and `create --provider aws` fails
cleanly at the base-AMI gate having provisioned nothing.

**It has never booted a real EC2 instance.** Everything is mocked-SDK tested, which proves the logic
and not the API. Treat it as unshipped until phase 7 runs.

## What's already set up in AWS

- Org `o-vpchgdp30j`, management account **Waldos** (`042743439392`).
- OU **AgentBoxMarco** (`ou-eysz-m5n5dw65`) under root `r-eysz`.
- Account **AgentBoxMarco** (`048679570010`), created 2026-07-12 and moved into that OU.
- Host profile `agentboxmarco` — chains `OrganizationAccountAccessRole` off `source_profile = waldos`
  (which holds static keys), region `us-east-1`. No IAM user, no SSO, no access key in the account.

  Note for anyone re-doing this in **zsh**: write the profile with a *quoted* heredoc (`<<'EOF'`) or
  `${ACCT}:role`. In an unquoted heredoc zsh parses `$ACCT:role` as a history modifier (`:r` = strip
  extension), silently eating the `:r` and producing `…:048679570010ole/…`.

## Step 1 — create the account (you, on the host)

This is the irreversible bit (90-day close, the email is burned for reuse), which is why it is not
automated.

```bash
aws organizations create-account \
  --email marco+agentboxmarco@waldos.ai \
  --account-name AgentBoxMarco \
  --profile waldos

# async — poll until SUCCEEDED, and grab the AccountId
aws organizations list-create-account-status --states SUCCEEDED --profile waldos \
  --query 'CreateAccountStatuses[?AccountName==`AgentBoxMarco`].AccountId' --output text
```

```bash
ACCT=<account id from above>

# move it into the OU
aws organizations move-account --account-id "$ACCT" \
  --source-parent-id r-eysz --destination-parent-id ou-eysz-m5n5dw65 --profile waldos

# a host profile that assumes into it — no IAM user needed, it chains off waldos
cat >> ~/.aws/config <<EOF

[profile agentboxmarco]
role_arn       = arn:aws:iam::$ACCT:role/OrganizationAccountAccessRole
source_profile = waldos
region         = us-east-1
EOF

aws sts get-caller-identity --profile agentboxmarco   # should print $ACCT
```

You do **not** need to create a VPC, an IAM user, or an access key. `agentbox aws login` offers to
create the default VPC if the account has none, and it dry-runs the IAM actions it needs (the
`OrganizationAccountAccessRole` is admin in the member account, so they will all pass).

## Step 2 — run the live e2e

From the host, on the branch, with `AWS_PROFILE=agentboxmarco`:

```bash
pnpm build
node apps/cli/dist/index.js aws login          # pick the agentboxmarco profile
node apps/cli/dist/index.js aws login --status # shows the account id + region

node apps/cli/dist/index.js prepare --provider aws   # bakes the base AMI, ~10-15 min
```

Watch `~/.agentbox/logs/latest.log`. When it finishes, **confirm the bake left nothing behind** —
this is the failure mode that costs money:

```bash
aws ec2 describe-instances --profile agentboxmarco --region us-east-1 \
  --filters 'Name=tag:agentbox.role,Values=prepare' \
  --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text
aws ec2 describe-security-groups --profile agentboxmarco --region us-east-1 \
  --filters 'Name=group-name,Values=agentbox-prepare-*' --query 'SecurityGroups[].GroupId' --output text
```

Then the box:

```bash
node apps/cli/dist/index.js create -y -n aws-smoke --provider aws
node apps/cli/dist/index.js shell aws-smoke -- 'uname -a && docker run --rm hello-world'
node apps/cli/dist/index.js url aws-smoke
node apps/cli/dist/index.js aws firewall show aws-smoke
node apps/cli/dist/index.js checkpoint create aws-smoke --name ckpt-1

# THE ONE MOST LIKELY TO BREAK — the public IP changes here
node apps/cli/dist/index.js pause aws-smoke
node apps/cli/dist/index.js unpause aws-smoke
node apps/cli/dist/index.js shell aws-smoke -- 'echo still reachable'

node apps/cli/dist/index.js destroy aws-smoke
node apps/cli/dist/index.js prune --provider aws
```

### The orphan sweep (do not skip)

Destroy must leave **no instance, no security group, no AMI, and no EBS snapshot**. The snapshot one
is the trap: deregistering an AMI does not delete the volumes behind it, and those bill forever,
invisibly. `deleteSnapshot` is written to do both — this is where you find out if it works.

```bash
P="--profile agentboxmarco --region us-east-1"
aws ec2 describe-instances $P --filters 'Name=tag:agentbox.managed,Values=true' \
  'Name=instance-state-name,Values=pending,running,stopping,stopped' \
  --query 'Reservations[].Instances[].InstanceId' --output text
aws ec2 describe-security-groups $P --filters 'Name=tag:agentbox.managed,Values=true' \
  --query 'SecurityGroups[].GroupId' --output text
aws ec2 describe-images $P --owners self --query 'Images[].[ImageId,Name]' --output text
aws ec2 describe-snapshots $P --owner-ids self --query 'Snapshots[].[SnapshotId,Description]' --output text
```

After `destroy` + deleting the checkpoint, the first two must be empty and the last two must contain
only the base AMI and its snapshot.

## The three things most likely to bite

1. **The public IP changes across stop/start.** No Elastic IP, so a resumed instance answers on a
   different address. `backend.ts` tracks `tunnelIps` and tears down a ControlMaster opened against a
   stale one. If `shell` hangs after `unpause`, that is the bug — look there first.
2. **The bake logs in as `root`, not `ubuntu`.** `install-box.sh` renames the UID-1000 user to
   `vscode`, and on a Canonical AMI that user *is* `ubuntu` — `usermod -l` refuses to rename an
   account with running processes. Root key auth is written from cloud-init `runcmd`. If `prepare`
   dies with "ssh did not come up", check the instance's system log in the EC2 console: the runcmd
   that installs `/root/.ssh/authorized_keys` is the suspect.
3. **AMIs are region-scoped.** The bake region is recorded in `~/.agentbox/aws-prepared.json`, and a
   create in a different region fails loud rather than returning a confusing `InvalidAMIID.NotFound`.
   If you change `box.awsRegion`, re-run `prepare`.

## Dogfooding from a box (optional)

Only needed if you want an agent *inside a box* to drive AWS. A box cannot use an SSO profile (the
token in `~/.aws/sso/cache` needs a browser to refresh), so we export the credentials the profile
resolves to:

```bash
aws sso login --profile agentboxmarco
pnpm aws:creds          # -> ./aws_credentials/{config,credentials}, gitignored, 0600
agentbox claude         # carry: copies them to the box's ~/.aws/
```

No IAM user, no long-lived key. They expire (~1h for an SSO role session) and `carry:` copies them
in at create time only, so a long-lived box will see `ExpiredToken` — re-run `pnpm aws:creds` and
re-create the box.

## When phase 7 passes

- Flip phase 7 to done in [`../aws_backlog.md`](../aws_backlog.md) and record what actually happened
  (region, instance type, bake wall-clock, anything that surprised you).
- Open the PR off `origin/nightly` — **not** off local nightly, which can carry other people's
  unpushed commits.
