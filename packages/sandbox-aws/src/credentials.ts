/**
 * First-run AWS setup for `agentbox install` / `agentbox aws login`.
 *
 * AWS is the odd one out among the providers: there is no single API token to
 * paste. Credentials come from the SDK's default provider chain, and most
 * developers already have a working `~/.aws` (a profile, often SSO-backed). So
 * the flow has two branches:
 *
 *   A. `~/.aws` exists -> pick a profile, persist `AWS_PROFILE` + `AWS_REGION`
 *      as *pointers*, and we're done. No IAM user, no static keys, nothing
 *      created. This is the common case.
 *   B. no usable credentials -> paste an access key pair (the fallback), then
 *      run the permission sweep and hand over the policy (see `setup-iam.ts`).
 *
 * Either way we finish by dry-running the permissions we need, so a
 * missing IAM action is reported *here*, with the exact list and a paste-able
 * policy — not twenty minutes into an AMI bake.
 */

import { existsSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  cancel,
  confirm,
  isCancel,
  intro,
  log,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from '@clack/prompts';
import type { CredSetResult } from '@agentbox/sandbox-core';
import { makeAwsClient, type AwsClient } from './client.js';
import { AWS_KEYS, ensureAwsEnvLoaded, parseEnvFile } from './env-loader.js';
import {
  hasAwsCli,
  iamCliCommands,
  openIamConsole,
  preflightPermissions,
  renderPolicyForUser,
  runSsoLogin,
  IAM_CREATE_POLICY_URL,
  POLICY_NAME,
} from './setup-iam.js';

const DEFAULT_REGION = 'us-east-1';

/**
 * Keys we manage in `~/.agentbox/secrets.env`. We strip prior values before
 * appending so the file never accumulates duplicates — and, importantly, so
 * switching from the profile branch to the static-key branch (or back) doesn't
 * leave the old identity behind to be picked up by the SDK chain.
 */
const MANAGED_KEYS = AWS_KEYS;

/** Ctrl+C at a prompt resolves with the cancel symbol; turn that into a real quit. */
function exitOnCancel<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel('Cancelled.');
    process.exit(130);
  }
  return v as T;
}

export interface EnsureAwsCredentialsOptions {
  /** Re-prompt even when valid credentials are already present (`agentbox aws login`). */
  force?: boolean;
}

export async function ensureAwsCredentials(opts: EnsureAwsCredentialsOptions = {}): Promise<void> {
  ensureAwsEnvLoaded();

  if (!opts.force && hasUsableCredentials()) return;
  // Non-TTY (scripted / CI): stay silent and let the API report the auth error,
  // rather than hanging on a prompt nobody can answer.
  if (!process.stdin.isTTY) return;

  intro('AWS setup');

  const profiles = readAwsProfiles();
  const chosen =
    profiles.length > 0 ? await chooseProfileOrKeys(profiles) : await promptForStaticKeys();

  const creds = await validateAndRetry(chosen);
  if (!creds) return;

  persistCredentials(creds.fields);
  log.success(`AWS credentials saved to ${secretsPath()}`);
  if (creds.accountId) {
    log.info(`Authenticated to AWS account ${creds.accountId}.`);
  }

  const client = makeAwsClient({ region: creds.fields.AWS_REGION });
  await ensureDefaultVpc(client, creds.hasDefaultVpc);
  await reportPermissions(client, creds.fields.AWS_PROFILE);

  outro('Setup complete.');
}

/** True when *something* in the chain can plausibly authenticate. */
function hasUsableCredentials(): boolean {
  return (
    (typeof process.env.AWS_PROFILE === 'string' && process.env.AWS_PROFILE.length > 0) ||
    (typeof process.env.AWS_ACCESS_KEY_ID === 'string' && process.env.AWS_ACCESS_KEY_ID.length > 0)
  );
}

type CredFields = Partial<Record<(typeof AWS_KEYS)[number], string>> & { AWS_REGION: string };

/** Branch A + the escape hatch into branch B. */
async function chooseProfileOrKeys(profiles: AwsProfile[]): Promise<CredFields> {
  note(
    `AgentBox uses the AWS SDK's default credential chain, so an existing profile just works.\n` +
      'Nothing is created in your account by this step.',
    `${String(profiles.length)} profile${profiles.length === 1 ? '' : 's'} found in ~/.aws`,
  );

  const PASTE = '__paste__';
  const picked = exitOnCancel(
    await select({
      message: 'Which AWS profile should AgentBox use?',
      options: [
        ...profiles.map((p) => ({
          value: p.name,
          label: p.name,
          hint: [p.sso ? 'SSO' : undefined, p.region].filter(Boolean).join(', ') || undefined,
        })),
        { value: PASTE, label: 'Paste an access key pair instead', hint: 'no ~/.aws profile' },
      ],
    }),
  ) as string;

  if (picked === PASTE) return promptForStaticKeys();

  const profile = profiles.find((p) => p.name === picked);
  const region = exitOnCancel(
    await text({
      message: 'Which region should new boxes run in?',
      initialValue: profile?.region ?? DEFAULT_REGION,
      placeholder: DEFAULT_REGION,
      validate: (v) => (v.trim().length === 0 ? 'Cannot be empty' : undefined),
    }),
  ).trim();

  return { AWS_PROFILE: picked, AWS_REGION: region };
}

/** Branch B: static keys. */
async function promptForStaticKeys(): Promise<CredFields> {
  note(
    'AgentBox will use these to create EC2 instances for your boxes.\n' +
      'Create them in the AWS console under IAM -> Users -> Security credentials -> Access keys.',
    'Access key required',
  );

  const accessKeyId = exitOnCancel(
    await text({
      message: 'AWS access key id',
      placeholder: 'AKIA…',
      validate: (v) => (v.trim().length === 0 ? 'Cannot be empty' : undefined),
    }),
  ).trim();

  const secretAccessKey = exitOnCancel(
    await password({
      message: 'AWS secret access key',
      validate: (v) => (v.trim().length === 0 ? 'Cannot be empty' : undefined),
    }),
  ).trim();

  const region = exitOnCancel(
    await text({
      message: 'Which region should new boxes run in?',
      initialValue: DEFAULT_REGION,
      validate: (v) => (v.trim().length === 0 ? 'Cannot be empty' : undefined),
    }),
  ).trim();

  return {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_REGION: region,
  };
}

interface ValidatedCreds {
  fields: CredFields;
  accountId?: string;
  hasDefaultVpc: boolean;
}

/**
 * Validate the chosen credentials, with one recovery attempt for the single
 * most common AWS failure: an expired SSO token. Rather than dumping the SDK's
 * `ExpiredToken`, offer to run `aws sso login --profile <p>` and retry.
 */
async function validateAndRetry(fields: CredFields): Promise<ValidatedCreds | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    applyToEnv(fields);
    const result = await validateCredentials(fields);

    if (result.ok) {
      return { fields, accountId: result.accountId, hasDefaultVpc: result.hasDefaultVpc };
    }

    if (result.kind === 'expired' && attempt === 0 && fields.AWS_PROFILE) {
      log.warn(`The SSO session for profile "${fields.AWS_PROFILE}" has expired.`);
      const doLogin = exitOnCancel(
        await confirm({
          message: `Run \`aws sso login --profile ${fields.AWS_PROFILE}\` now?`,
          initialValue: true,
        }),
      );
      if (doLogin && hasAwsCli()) {
        if (runSsoLogin(fields.AWS_PROFILE)) continue;
        log.error('`aws sso login` failed.');
      } else if (doLogin) {
        log.error('The AWS CLI is not installed, so AgentBox cannot refresh the SSO session.');
      }
      cancel(`Refresh the session, then re-run \`agentbox aws login\`.`);
      return null;
    }

    if (result.kind === 'network') {
      log.warn(`Could not reach AWS to validate (${result.message}) — saving anyway.`);
      persistCredentials(fields);
      outro('Setup complete (unvalidated).');
      return null;
    }

    cancel(`AWS rejected those credentials: ${result.message}`);
    return null;
  }
  return null;
}

type ValidationResult =
  | { ok: true; accountId?: string; hasDefaultVpc: boolean }
  | { ok: false; kind: 'auth' | 'expired' | 'network'; message: string };

/**
 * One `DescribeVpcs(isDefault)` call does triple duty: it proves the credentials
 * work, yields the account id (as the default VPC's `OwnerId` — no
 * `@aws-sdk/client-sts` dep needed), and answers the default-VPC preflight.
 */
async function validateCredentials(fields: CredFields): Promise<ValidationResult> {
  const s = spinner();
  s.start('Validating credentials with AWS');
  try {
    const client = makeAwsClient({ region: fields.AWS_REGION });
    const vpc = await client.describeDefaultVpc();
    s.stop('AWS credentials accepted');
    return { ok: true, accountId: vpc?.ownerId, hasDefaultVpc: vpc !== null };
  } catch (err) {
    s.stop('AWS credential check failed');
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code ?? '';
    if (/ExpiredToken|TokenRefreshRequired|SSOTokenProviderFailure|expired/i.test(`${code} ${message}`)) {
      return { ok: false, kind: 'expired', message };
    }
    if (/AuthFailure|UnrecognizedClient|InvalidClientTokenId|SignatureDoesNotMatch|AccessDenied|Unauthorized|CredentialsProviderError/i.test(`${code} ${message}`)) {
      return { ok: false, kind: 'auth', message };
    }
    return { ok: false, kind: 'network', message };
  }
}

/**
 * A brand-new AWS account (and every account created since 2022 with the default
 * settings off) may have no default VPC. Boxes need one — or an explicit
 * `box.awsSubnetId`. `CreateDefaultVpc` is a single idempotent call, so offer it
 * rather than making the user go find the console page.
 */
async function ensureDefaultVpc(client: AwsClient, hasDefaultVpc: boolean): Promise<void> {
  if (hasDefaultVpc) return;

  log.warn('This account has no default VPC in that region, so boxes have nowhere to launch.');
  const create = exitOnCancel(
    await confirm({ message: 'Create a default VPC now?', initialValue: true }),
  );
  if (!create) {
    log.info(
      'Set an explicit subnet instead: `agentbox config set box.awsSubnetId subnet-…`.',
    );
    return;
  }
  const s = spinner();
  s.start('Creating the default VPC');
  try {
    const vpcId = await client.createDefaultVpc();
    s.stop(`Created default VPC ${vpcId}`);
  } catch (err) {
    s.stop('Could not create the default VPC');
    log.error(err instanceof Error ? err.message : String(err));
    log.info('Set an explicit subnet instead: `agentbox config set box.awsSubnetId subnet-…`.');
  }
}

/**
 * Dry-run every permission the provider needs and, if any are missing, hand over
 * the policy: written to disk, copied to the clipboard, and the IAM console
 * opened on its JSON tab (the console cannot be prefilled from a URL, so
 * clipboard + open is as close to one-click as AWS allows).
 */
async function reportPermissions(client: AwsClient, profile?: string): Promise<void> {
  const s = spinner();
  s.start('Checking IAM permissions (dry run — nothing is created)');
  const report = await preflightPermissions(client);
  s.stop(
    report.ok
      ? 'IAM permissions OK'
      : `Missing ${String(report.missing.length)} IAM permission${report.missing.length === 1 ? '' : 's'}`,
  );

  for (const u of report.undetermined) {
    log.warn(`Could not check ${u.action}: ${u.reason}`);
  }

  if (report.ok) return;

  const handoff = renderPolicyForUser();
  note(
    `These credentials${profile ? ` (profile "${profile}")` : ''} cannot:\n` +
      report.missing.map((m) => `  - ${m}`).join('\n') +
      `\n\nThe policy that grants them is at:\n  ${handoff.path}` +
      (handoff.copied ? '\n  (also copied to your clipboard)' : ''),
    'IAM permissions missing',
  );

  if (hasAwsCli()) {
    const cmds = iamCliCommands(null);
    note(cmds.join('\n'), 'Attach it with the AWS CLI');
  }

  const open = exitOnCancel(
    await confirm({
      message: `Open the IAM console to create the "${POLICY_NAME}" policy?`,
      initialValue: true,
    }),
  );
  if (open && !openIamConsole()) {
    log.warn(`Could not auto-open the browser — visit ${IAM_CREATE_POLICY_URL} manually.`);
  }
  if (open) {
    log.info(
      `Paste the JSON into the console's JSON tab, name the policy "${POLICY_NAME}", attach it to ` +
        'your user or role, then re-run `agentbox aws login` to re-check.',
    );
  }
}

// ---- profile discovery ----

export interface AwsProfile {
  name: string;
  region?: string;
  /** True when the profile authenticates via IAM Identity Center (SSO). */
  sso: boolean;
}

/**
 * Profiles declared in `~/.aws/config` (`[profile x]`, `[default]`) and
 * `~/.aws/credentials` (`[x]`). We only parse names/region/sso — never the
 * secrets, which stay where the SDK expects them.
 */
export function readAwsProfiles(homeDir = homedir()): AwsProfile[] {
  const found = new Map<string, AwsProfile>();

  const config = readIniSections(resolve(homeDir, '.aws', 'config'));
  for (const [section, entries] of config) {
    // `[default]` and `[profile foo]`; skip `[sso-session foo]` and friends —
    // they are referenced BY profiles, not usable as one.
    let name: string | null = null;
    if (section === 'default') name = 'default';
    else if (section.startsWith('profile ')) name = section.slice('profile '.length).trim();
    if (!name) continue;

    found.set(name, {
      name,
      region: entries.region,
      sso: Object.keys(entries).some((k) => k.startsWith('sso_')),
    });
  }

  const creds = readIniSections(resolve(homeDir, '.aws', 'credentials'));
  for (const [section, entries] of creds) {
    if (found.has(section)) continue;
    found.set(section, { name: section, region: entries.region, sso: false });
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Minimal INI reader: `[section]` + `key = value`, `#`/`;` comments. */
function readIniSections(path: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (!existsSync(path)) return out;
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  let current: string | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1).trim();
      if (!out.has(current)) out.set(current, {});
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const entries = out.get(current);
    if (entries) entries[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// ---- persistence ----

function applyToEnv(fields: CredFields): void {
  // Clear the whole managed set first: leaving a stale AWS_PROFILE next to a
  // fresh static-key pair (or vice versa) makes the SDK chain resolve an
  // identity the user did not just choose.
  for (const k of MANAGED_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && v.length > 0) process.env[k] = v;
  }
}

function persistCredentials(fields: CredFields): void {
  applyToEnv(fields);
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });

  let existing = '';
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      existing = '';
    }
  }

  const kept = existing
    .split(/\r?\n/)
    .filter((line) => {
      const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
      const eq = stripped.indexOf('=');
      if (eq <= 0) return true;
      return !(MANAGED_KEYS as readonly string[]).includes(stripped.slice(0, eq).trim());
    })
    .join('\n')
    .replace(/\s+$/u, '');

  const lines = MANAGED_KEYS.filter((k) => {
    const v = fields[k];
    return typeof v === 'string' && v.length > 0;
  }).map((k) => `${k}=${fields[k] ?? ''}`);

  const body = (kept ? `${kept}\n` : '') + lines.join('\n') + '\n';

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort; writeFileSync mode already covers most filesystems.
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore — already attempted above.
  }
}

/**
 * Non-interactive credential set (the headless path the hub drives). Accepts
 * either `{ profile, region }` or `{ accessKeyId, secretAccessKey, region }`.
 */
export async function setAwsCredentials(fields: Record<string, string>): Promise<CredSetResult> {
  const region = (fields.region ?? '').trim() || DEFAULT_REGION;
  const profile = (fields.profile ?? '').trim();
  const accessKeyId = (fields.accessKeyId ?? '').trim();
  const secretAccessKey = (fields.secretAccessKey ?? '').trim();

  let creds: CredFields;
  if (profile) {
    creds = { AWS_PROFILE: profile, AWS_REGION: region };
  } else if (accessKeyId && secretAccessKey) {
    creds = {
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_REGION: region,
    };
  } else {
    return {
      ok: false,
      error: 'either `profile`, or both `accessKeyId` and `secretAccessKey`, are required',
      status: { configured: false },
    };
  }

  const result = await validateCredentials(creds);
  if (!result.ok && result.kind !== 'network') {
    return {
      ok: false,
      error: `credentials rejected by AWS: ${result.message}`,
      status: { configured: false },
    };
  }
  persistCredentials(creds);
  const label = result.ok
    ? profile
      ? `profile ${profile}`
      : 'access key'
    : 'unvalidated';
  return { ok: true, status: { configured: true, label } };
}

export function secretsPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

export interface AwsCredStatus {
  profile?: string;
  accessKeyId?: string;
  region?: string;
  source: 'env' | 'secrets.env' | 'none';
}

export function readAwsCredStatus(): AwsCredStatus {
  const shellHad = !!process.env.AWS_PROFILE || !!process.env.AWS_ACCESS_KEY_ID;
  ensureAwsEnvLoaded();
  const profile = process.env.AWS_PROFILE;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const region = process.env.AWS_REGION;
  if (!profile && !accessKeyId) return { source: 'none' };
  return {
    profile,
    accessKeyId,
    region,
    source: shellHad ? 'env' : 'secrets.env',
  };
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${'*'.repeat(8)}${value.slice(-4)}`;
}

/** Snapshot of the managed env keys (used by tests around `applyToEnv`). */
export function snapshotManagedEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of MANAGED_KEYS) out[k] = process.env[k];
  return out;
}

export function restoreManagedEnv(snap: Record<string, string | undefined>): void {
  for (const k of MANAGED_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

export { parseEnvFile };
