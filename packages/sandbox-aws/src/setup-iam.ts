/**
 * The IAM half of `agentbox aws login`: figure out what the user's credentials
 * are actually allowed to do, and — when something is missing — hand them the
 * policy in the most paste-able form the AWS console allows.
 *
 * The load-bearing idea is **diagnose, don't guess**. Every mutating EC2 API
 * supports `DryRun: true`, which evaluates IAM and then stops without creating
 * anything. It signals "you may do this" by *throwing* `DryRunOperation` and
 * "you may not" by throwing `UnauthorizedOperation` — an inverted-looking
 * convention that is easy to get backwards, so it is asserted in the tests.
 *
 * Without this sweep the first sign of a missing permission is an opaque
 * `UnauthorizedOperation` twenty minutes into an AMI bake, after a security
 * group and an instance already exist.
 *
 * Note what is deliberately NOT here: we never create an IAM user, and never
 * mint an access key. A long-lived key pair in `~/.agentbox/secrets.env` is
 * strictly worse than the SSO session the user already has, and creating one
 * would demand `iam:CreateUser` at setup time for privilege the provider never
 * needs at runtime.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { hostOpenCommand, writeHostClipboardText } from '@agentbox/sandbox-core';
import {
  PROBE_IAM_ACTION,
  type AwsClient,
  type AwsDryRunProbe,
} from './client.js';

/** The IAM console, landing on the create-policy JSON editor. */
export const IAM_CREATE_POLICY_URL = 'https://console.aws.amazon.com/iam/home#/policies$new?step=edit';

export const POLICY_NAME = 'AgentBoxEC2';

/**
 * The minimum IAM policy the AWS provider needs. Single source of truth: the
 * wizard writes this, and the public docs embed the same JSON — so they cannot
 * drift.
 *
 * Scoped to EC2 only, and to no IAM/billing/organizational actions whatsoever.
 * `Resource: '*'` is not laziness: EC2's Describe* actions do not accept a
 * resource ARN at all, and RunInstances legitimately touches AMIs, subnets,
 * volumes and network interfaces the account owns. Narrowing this meaningfully
 * needs tag-based conditions, which would break the very first `prepare` (the
 * bake instance has to exist before it can be tagged).
 */
export const AGENTBOX_EC2_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AgentBoxReadEC2',
      Effect: 'Allow',
      Action: [
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceTypes',
        'ec2:DescribeInstanceTypeOfferings',
        'ec2:DescribeImages',
        'ec2:DescribeSnapshots',
        'ec2:DescribeVpcs',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeRegions',
        'ec2:DescribeAvailabilityZones',
      ],
      Resource: '*',
    },
    {
      Sid: 'AgentBoxManageBoxes',
      Effect: 'Allow',
      Action: [
        'ec2:RunInstances',
        'ec2:StartInstances',
        'ec2:StopInstances',
        'ec2:TerminateInstances',
        'ec2:CreateTags',
      ],
      Resource: '*',
    },
    {
      Sid: 'AgentBoxManageFirewall',
      Effect: 'Allow',
      Action: [
        'ec2:CreateSecurityGroup',
        'ec2:DeleteSecurityGroup',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupIngress',
      ],
      Resource: '*',
    },
    {
      Sid: 'AgentBoxManageImages',
      Effect: 'Allow',
      Action: ['ec2:CreateImage', 'ec2:DeregisterImage', 'ec2:DeleteSnapshot'],
      Resource: '*',
    },
  ],
} as const;

/** Every permission we probe, in the order a create would exercise them. */
export const REQUIRED_PROBES: readonly AwsDryRunProbe[] = [
  'CreateSecurityGroup',
  'AuthorizeSecurityGroupIngress',
  'RunInstances',
  'CreateTags',
  'CreateImage',
  'StopInstances',
  'StartInstances',
  'TerminateInstances',
];

export interface PermissionReport {
  /** True when every probe came back permitted. */
  ok: boolean;
  /** IAM action names (`ec2:RunInstances`, …) the credentials are missing. */
  missing: string[];
  /**
   * Probes that could not be evaluated (a throttle, a network blip, an
   * unexpected error). Reported separately from `missing` so we never tell
   * someone to fix a permission that is actually fine.
   */
  undetermined: { action: string; reason: string }[];
}

/**
 * Dry-run every permission the provider needs and report exactly which IAM
 * actions are missing.
 *
 * An unexpected error on one probe does NOT become a "missing permission" —
 * it lands in `undetermined`. Telling a user to grant a permission they already
 * have, because their network hiccuped, is worse than saying "couldn't check".
 */
export async function preflightPermissions(client: AwsClient): Promise<PermissionReport> {
  const missing: string[] = [];
  const undetermined: { action: string; reason: string }[] = [];

  for (const probe of REQUIRED_PROBES) {
    const action = PROBE_IAM_ACTION[probe];
    try {
      const allowed = await client.dryRun(probe);
      if (!allowed) missing.push(action);
    } catch (err) {
      undetermined.push({ action, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { ok: missing.length === 0, missing, undetermined };
}

/** Where we drop the policy JSON for the user to attach. */
export function policyFilePath(): string {
  return resolve(homedir(), '.agentbox', 'aws', 'agentbox-ec2-policy.json');
}

export const POLICY_JSON = JSON.stringify(AGENTBOX_EC2_POLICY, null, 2);

export interface PolicyHandoff {
  /** Absolute path the policy JSON was written to. */
  path: string;
  /** True when the JSON also made it onto the clipboard. */
  copied: boolean;
}

/**
 * Write the policy JSON to disk and copy it to the clipboard, so the user can
 * paste it straight into the IAM console's JSON tab.
 *
 * The console has no prefill parameter — you cannot hand it a policy in a URL —
 * so "clipboard + open the JSON tab" is as close to one-click as AWS allows.
 */
export function renderPolicyForUser(): PolicyHandoff {
  const path = policyFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${POLICY_JSON}\n`, { mode: 0o600 });
  return { path, copied: writeHostClipboardText(POLICY_JSON) };
}

/** Best-effort: open the IAM create-policy page. */
export function openIamConsole(): boolean {
  try {
    const r = spawnSync(hostOpenCommand(), [IAM_CREATE_POLICY_URL], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** True when the AWS CLI is on PATH — gates the `aws iam …` fast lane. */
export function hasAwsCli(): boolean {
  try {
    return spawnSync('sh', ['-c', 'command -v aws'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * The two commands that create + attach the policy, for a user who would rather
 * paste into a terminal than a browser. `principal` is the IAM user or role the
 * current credentials resolve to.
 */
export function iamCliCommands(principal: { kind: 'user' | 'role'; name: string } | null): string[] {
  const create = `aws iam create-policy --policy-name ${POLICY_NAME} --policy-document file://${policyFilePath()}`;
  if (!principal) {
    return [
      create,
      `# then attach it to the user or role you authenticate as:`,
      `aws iam attach-user-policy --user-name <you> --policy-arn arn:aws:iam::<account-id>:policy/${POLICY_NAME}`,
    ];
  }
  const attach =
    principal.kind === 'user'
      ? `aws iam attach-user-policy --user-name ${principal.name} --policy-arn arn:aws:iam::<account-id>:policy/${POLICY_NAME}`
      : `aws iam attach-role-policy --role-name ${principal.name} --policy-arn arn:aws:iam::<account-id>:policy/${POLICY_NAME}`;
  return [create, attach];
}

/**
 * Run `aws sso login --profile <p>` for the user, inheriting stdio so the CLI
 * can print its verification code and open the browser. Returns true on success.
 *
 * This is the fix for the single most common AWS failure mode — an expired SSO
 * token — which would otherwise surface as a raw `ExpiredToken` SDK stack.
 */
export function runSsoLogin(profile: string): boolean {
  try {
    const r = spawnSync('aws', ['sso', 'login', '--profile', profile], { stdio: 'inherit' });
    return r.status === 0;
  } catch {
    return false;
  }
}
