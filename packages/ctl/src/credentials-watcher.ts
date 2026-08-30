import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { PostOutcome, RelayClient } from './relay-client.js';
import { CREDENTIALS_UPDATED_EVENT } from './types.js';
import type { AgentId } from '@agentbox/core';

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
 * Delivery is confirmed, not assumed. The mtime/hash bookkeeping used to be
 * committed before the fire-and-forget post was even attempted, so a post lost
 * to a relay restart was lost forever: both gates then suppressed the resend,
 * and since a Claude refresh ROTATES the refresh token, every other copy of
 * that login was dead with no trace anywhere. Now nothing is recorded until the
 * relay answers, and the next tick simply tries again — which is also why a ctl
 * restart heals by itself (the maps start empty, the file is still on disk).
 *
 * Disabled per box via env `AGENTBOX_CREDENTIAL_SYNC=0` (the wire form of the
 * `box.credentialSync` config key / `--no-credential-sync` create flag).
 */

export interface WatchedCredential {
  agent: AgentId;
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
  /** Per-post budget. Longer than the relay default: a cloud box's post travels
   *  through the bridge, and losing this event is expensive. */
  postTimeoutMs?: number;
}

/**
 * Whether a failed post is worth retrying. A 4xx means this exact payload will
 * never be accepted (malformed, unknown agent, bad token), so retrying it every
 * tick forever is pointless noise — record it as done and move on. 408/429 are
 * the two 4xx that explicitly mean "try again". Everything else — 5xx, and a
 * null status (connection refused, timeout) — is transient.
 */
export function isRetryablePostFailure(outcome: PostOutcome): boolean {
  if (outcome.ok) return false;
  const { status } = outcome;
  if (status === null) return true;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}

export class CredentialsWatcher {
  private readonly relay: RelayClient;
  private readonly intervalMs: number;
  private files: readonly WatchedCredential[];
  private readonly postTimeoutMs: number;
  private readonly lastMtime = new Map<string, number>();
  private readonly lastPosted = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: CredentialsWatcherOptions) {
    this.relay = opts.relay;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.files = opts.files ?? WATCHED_CREDENTIALS;
    this.postTimeoutMs = opts.postTimeoutMs ?? 10_000;
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

  /**
   * Swap the watched list while running — the daemon starts this watcher with
   * the BAKED list so credential fan-out is never off, then calls this once the
   * host answers `agents.list`. Waiting for that answer before constructing the
   * watcher is what made a cloud box with no host poller lose fan-out entirely.
   *
   * Safe mid-flight: `lastMtime` / `lastPosted` are keyed by `file.agent`, so a
   * carried-over agent keeps its de-dup state and a dropped one just leaves an
   * unread key behind.
   */
  setFiles(files: readonly WatchedCredential[]): void {
    this.files = files;
    if (this.timer) void this.scan();
  }

  /**
   * One last awaited pass, for shutdown — the counterpart of
   * `StatusReporter.flush()`. Without it a rotation in a box's final 15s is
   * dropped with no attempt at all, since `stop()` only clears the timer.
   */
  async flush(): Promise<void> {
    await this.scan();
  }

  /** One poll pass; exposed for tests. Never throws. */
  async scan(): Promise<void> {
    if (!this.relay.enabled) return;
    for (const file of this.files) {
      try {
        const st = await stat(file.path);
        if (this.lastMtime.get(file.agent) === st.mtimeMs) continue;
        const text = await readFile(file.path, 'utf8');
        // Only now is the read known good: recording the mtime before this
        // would permanently skip a file caught mid-write.
        if (!isRealCredentialText(file.shape, text)) {
          // Same mtime will still be a placeholder next tick — don't re-read it.
          this.lastMtime.set(file.agent, st.mtimeMs);
          continue;
        }
        const hash = createHash('sha256').update(text).digest('hex');
        if (this.lastPosted.get(file.agent) === hash) {
          this.lastMtime.set(file.agent, st.mtimeMs);
          continue;
        }
        const outcome = await this.relay.post(
          CREDENTIALS_UPDATED_EVENT,
          {
            schema: 1,
            agent: file.agent,
            contentBase64: Buffer.from(text, 'utf8').toString('base64'),
            capturedAt: new Date().toISOString(),
          },
          { timeoutMs: this.postTimeoutMs },
        );
        // Leave both maps untouched on a retryable failure: the next tick re-reads
        // the same file and tries again until the relay actually has it.
        if (isRetryablePostFailure(outcome)) continue;
        this.lastMtime.set(file.agent, st.mtimeMs);
        this.lastPosted.set(file.agent, hash);
      } catch {
        // Missing file / transient read error — try again next tick.
      }
    }
  }
}
