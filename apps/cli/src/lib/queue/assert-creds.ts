import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  hostBackupHasCredentials,
  OPENCODE_FORWARDED_ENV_KEYS,
  SHARED_OPENCODE_VOLUME,
  volumeHasOpencodeAuth,
} from '@agentbox/sandbox-docker';
import {
  SHARED_CODEX_VOLUME,
  volumeHasCodexAuth,
} from '@agentbox/agent-codex';
import type { QueueAgentKind } from '@agentbox/relay';
import { normalizeLastAgent } from '@agentbox/core';
import { resolveClaudeAuth } from '../../auth.js';
import { resolveClaudeCredHealth } from '../claude-cred-health.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when Claude is already authenticated on the host: a forwarded env var
 * (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`), the legacy
 * `~/.agentbox/auth.json` setup-token, or a real OAuth refresh token in the
 * host backup (`~/.agentbox/claude-credentials.json`). The backup is what the
 * foreground sync writes whenever a box's claude logs in, so its presence is
 * the load-bearing signal that the shared volume has been seeded.
 */
export async function claudeAuthAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  const resolved = await resolveClaudeAuth(env);
  if (resolved.source !== 'none') return true;
  return hostBackupHasCredentials();
}

/**
 * Richer Claude credential verdict for the non-interactive paths. `'missing'`
 * when nothing can seed a box; `'expired'` when the saved login can no longer be
 * renewed AND we're on a cloud provider — cloud has no shared volume to fall
 * back to, whereas a docker box boots from the volume's live copy and refreshes
 * it in-box. A host-env token (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`)
 * or legacy `auth.json` short-circuits to `'ok'`: it has no expiry concept here.
 * Mirrors the interactive `maybeRunCloudClaudeLogin` split, and shares its
 * verdict helper — so a merely-lapsed access token is renewed here too rather
 * than failing the job. This used to gate on `expiresAt` (the ~8h access token)
 * and so refused to submit perfectly good jobs every day.
 */
export async function claudeCredStatus(
  env: NodeJS.ProcessEnv,
  isCloud: boolean,
  image?: string,
): Promise<'ok' | 'missing' | 'expired'> {
  const resolved = await resolveClaudeAuth(env);
  if (resolved.source !== 'none') return 'ok';
  if (!isCloud) return (await hostBackupHasCredentials()) ? 'ok' : 'missing';
  const health = await resolveClaudeCredHealth({
    image: image ?? '',
    // No image to probe with means no renewal; answer off the backup alone.
    ...(image === undefined ? { offlineOnly: true } : {}),
  });
  if (health === 'missing') return 'missing';
  return health === 'dead' ? 'expired' : 'ok';
}

/**
 * True when Codex is already authenticated: `OPENAI_API_KEY` in env, a host
 * `~/.codex/auth.json`, or an `auth.json` already in the shared codex-config
 * volume. Mirrors the foreground command's local helper so the `-i`
 * pre-flight and the interactive login offer agree on what counts as
 * "seeded".
 */
export async function codexAuthAvailable(
  image: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if ((env['OPENAI_API_KEY'] ?? '').length > 0) return true;
  if (await fileExists(join(homedir(), '.codex', 'auth.json'))) return true;
  return volumeHasCodexAuth(SHARED_CODEX_VOLUME, image);
}

/**
 * True when OpenCode is already authenticated: any of its forwarded provider
 * env keys, a host `~/.local/share/opencode/auth.json`, or an `auth.json`
 * already in the shared opencode volume.
 */
export async function opencodeAuthAvailable(
  image: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  for (const k of OPENCODE_FORWARDED_ENV_KEYS) {
    if ((env[k] ?? '').length > 0) return true;
  }
  if (await fileExists(join(homedir(), '.local', 'share', 'opencode', 'auth.json'))) return true;
  return volumeHasOpencodeAuth(SHARED_OPENCODE_VOLUME, image);
}

/**
 * Wording for the agents we have something specific to say about. Not total —
 * see {@link missingCredsMessage}.
 */
const MESSAGES: Record<string, string> = {
  'claude-code':
    'No Claude credentials on host. Run `agentbox claude login` first (or `agentbox claude` interactively) to seed them, then retry.',
  codex:
    'No Codex credentials on host. Run `agentbox codex login` first (or set OPENAI_API_KEY) to seed them, then retry.',
  opencode:
    'No OpenCode credentials on host. Run `agentbox opencode login` first to seed them, then retry.',
};

/**
 * The specific message where we have one, a generic one otherwise. With
 * `QueueAgentKind` open, indexing {@link MESSAGES} is no longer total, and an
 * agent with no entry deserves usable wording rather than `undefined`.
 */
function missingCredsMessage(agent: QueueAgentKind): string {
  const id = normalizeLastAgent(agent) ?? agent;
  return (
    MESSAGES[agent] ??
    `No ${id} credentials on host. Run \`agentbox ${id} login\` first to seed them, then retry.`
  );
}

const CLAUDE_EXPIRED_MESSAGE =
  'Your saved Claude login can no longer be renewed. Sign in again with `agentbox claude login`, then retry.';

export class MissingAgentCredsError extends Error {
  readonly agent: QueueAgentKind;
  constructor(agent: QueueAgentKind, message: string) {
    super(message);
    this.name = 'MissingAgentCredsError';
    this.agent = agent;
  }
}

/**
 * Subclass for the present-but-expired case (Claude on cloud). Extends
 * {@link MissingAgentCredsError} so the existing `instanceof MissingAgentCredsError`
 * catches at the call sites still match (→ same fail-fast / exit 2), while callers
 * and tests can distinguish the reason.
 */
export class ExpiredAgentCredsError extends MissingAgentCredsError {
  constructor(agent: QueueAgentKind, message: string) {
    super(agent, message);
    this.name = 'ExpiredAgentCredsError';
  }
}

export interface AssertAgentCredsInput {
  agent: QueueAgentKind;
  image: string;
  env?: NodeJS.ProcessEnv;
  /** Provider for this run; gates the Claude renewability check to cloud (see
   *  {@link claudeCredStatus}). Omitted/`'docker'` → presence check only. */
  providerName?: string;
}

/**
 * Pre-flight for the background `-i` path: throw `MissingAgentCredsError`
 * when the chosen agent has no host-side credentials to seed into the box.
 * The worker (`_run-queued-job.ts`) runs in detached mode with no attach, so
 * an unauthenticated in-box agent would silently sit on its `/login` UI with
 * the user's prompt unprocessed until the user re-attaches — that is the UX
 * this guard prevents.
 */
export async function assertAgentCredsAvailable(input: AssertAgentCredsInput): Promise<void> {
  const env = input.env ?? process.env;
  if (input.agent === 'claude-code') {
    const isCloud = input.providerName !== undefined && input.providerName !== 'docker';
    const status = await claudeCredStatus(env, isCloud, input.image);
    if (status === 'missing')
      throw new MissingAgentCredsError(input.agent, missingCredsMessage(input.agent));
    if (status === 'expired') throw new ExpiredAgentCredsError(input.agent, CLAUDE_EXPIRED_MESSAGE);
    return;
  }
  const ok =
    input.agent === 'codex'
      ? await codexAuthAvailable(input.image, env)
      : await opencodeAuthAvailable(input.image, env);
  if (!ok) throw new MissingAgentCredsError(input.agent, missingCredsMessage(input.agent));
}
