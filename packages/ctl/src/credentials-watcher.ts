import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { RelayClient } from './relay-client.js';
import { CREDENTIALS_UPDATED_EVENT } from './types.js';

/**
 * Watches the in-box agent credential files and reports refreshed blobs to the
 * host relay. Claude's OAuth refresh *rotates* the refresh token, killing every
 * other copy (host backup, other boxes) — the host relay fans the fresh blob
 * out so the fleet stays logged in.
 *
 * Polling (mtime, then content hash), not `fs.watch`: credential writes are
 * atomic renames and inotify on the renamed path is unreliable. The first scan
 * posts the current blob too — the relay's newest-wins gate makes that a no-op
 * unless the box refreshed while the relay wasn't listening (self-healing).
 *
 * Disabled per box via env `AGENTBOX_CREDENTIAL_SYNC=0` (the wire form of the
 * `box.credentialSync` config key / `--no-credential-sync` create flag).
 */

export interface WatchedCredential {
  agent: 'claude' | 'codex' | 'opencode';
  /** In-box absolute path — mirrors `AGENT_SYNC_SPECS[..].credential.boxAbsPath`
   * (`@agentbox/sandbox-core`); a drift test keeps them in lockstep. */
  path: string;
  shape: 'claude-oauth' | 'nonempty-json';
}

export const WATCHED_CREDENTIALS: readonly WatchedCredential[] = [
  {
    agent: 'claude',
    path: '/home/vscode/.claude/.credentials.json',
    shape: 'claude-oauth',
  },
  { agent: 'codex', path: '/home/vscode/.codex/auth.json', shape: 'nonempty-json' },
  {
    agent: 'opencode',
    path: '/home/vscode/.local/share/opencode/auth.json',
    shape: 'nonempty-json',
  },
];

/** Mirror of the sandbox-core `isRealAgentCredential` shapes (drift-tested). */
export function isRealCredentialText(shape: WatchedCredential['shape'], text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object') return false;
  const obj = parsed as Record<string, unknown>;
  if (shape === 'nonempty-json') return Object.keys(obj).length > 0;
  const oauth = obj['claudeAiOauth'];
  if (oauth === null || typeof oauth !== 'object') return false;
  const refresh = (oauth as Record<string, unknown>)['refreshToken'];
  return typeof refresh === 'string' && refresh.length > 0;
}

export interface CredentialsWatcherOptions {
  relay: RelayClient;
  /** Poll cadence. Default 15000ms. */
  intervalMs?: number;
  /** Override the watched file list (tests). */
  files?: readonly WatchedCredential[];
}

export class CredentialsWatcher {
  private readonly relay: RelayClient;
  private readonly intervalMs: number;
  private readonly files: readonly WatchedCredential[];
  private readonly lastMtime = new Map<string, number>();
  private readonly lastPosted = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: CredentialsWatcherOptions) {
    this.relay = opts.relay;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.files = opts.files ?? WATCHED_CREDENTIALS;
  }

  start(): void {
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
    this.timer.unref();
    void this.scan();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll pass; exposed for tests. Never throws. */
  async scan(): Promise<void> {
    if (!this.relay.enabled) return;
    for (const file of this.files) {
      try {
        const st = await stat(file.path);
        if (this.lastMtime.get(file.agent) === st.mtimeMs) continue;
        this.lastMtime.set(file.agent, st.mtimeMs);
        const text = await readFile(file.path, 'utf8');
        if (!isRealCredentialText(file.shape, text)) continue;
        const hash = createHash('sha256').update(text).digest('hex');
        if (this.lastPosted.get(file.agent) === hash) continue;
        this.lastPosted.set(file.agent, hash);
        this.relay.post(CREDENTIALS_UPDATED_EVENT, {
          schema: 1,
          agent: file.agent,
          contentBase64: Buffer.from(text, 'utf8').toString('base64'),
          capturedAt: new Date().toISOString(),
        });
      } catch {
        // Missing file / transient read error — try again next tick.
      }
    }
  }
}
