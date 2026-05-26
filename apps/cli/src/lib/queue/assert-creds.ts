import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  hostBackupHasCredentials,
  OPENCODE_FORWARDED_ENV_KEYS,
  SHARED_CODEX_VOLUME,
  SHARED_OPENCODE_VOLUME,
  volumeHasCodexAuth,
  volumeHasOpencodeAuth,
} from '@agentbox/sandbox-docker';
import type { QueueAgentKind } from '@agentbox/relay';
import { resolveClaudeAuth } from '../../auth.js';

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

const MESSAGES: Record<QueueAgentKind, string> = {
  'claude-code':
    '-i / --initial-prompt: no Claude credentials on host. Run `agentbox claude login` first (or `agentbox claude` interactively) to seed them, then retry.',
  codex:
    '-i / --initial-prompt: no Codex credentials on host. Run `agentbox codex login` first (or set OPENAI_API_KEY) to seed them, then retry.',
  opencode:
    '-i / --initial-prompt: no OpenCode credentials on host. Run `agentbox opencode login` first to seed them, then retry.',
};

export class MissingAgentCredsError extends Error {
  readonly agent: QueueAgentKind;
  constructor(agent: QueueAgentKind, message: string) {
    super(message);
    this.name = 'MissingAgentCredsError';
    this.agent = agent;
  }
}

export interface AssertAgentCredsInput {
  agent: QueueAgentKind;
  image: string;
  env?: NodeJS.ProcessEnv;
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
  let ok = false;
  if (input.agent === 'claude-code') {
    ok = await claudeAuthAvailable(env);
  } else if (input.agent === 'codex') {
    ok = await codexAuthAvailable(input.image, env);
  } else {
    ok = await opencodeAuthAvailable(input.image, env);
  }
  if (!ok) throw new MissingAgentCredsError(input.agent, MESSAGES[input.agent]);
}
