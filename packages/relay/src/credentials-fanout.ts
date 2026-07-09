/**
 * Host-side handler for the ctl credential watcher's `credentials-updated`
 * events (see `packages/ctl/src/credentials-watcher.ts`). Claude's OAuth
 * refresh rotates the refresh token, so the moment one box refreshes, every
 * other copy (host backup, other boxes) is dead — this accepts the freshest
 * blob into `~/.agentbox/<agent>-credentials.json` (newest-wins) and fans it
 * out to all other boxes by spawning the host CLI
 * (`agentbox credentials propagate`), the same decoupling as the relay's
 * checkpoint/cp handlers.
 *
 * The payload carries a secret: callers must never append these events to the
 * event ring buffer (mirrors how `box-status` skips the ring).
 *
 * Concurrency: per-agent debounce (bursts collapse to one fan-out) + a
 * per-agent promise chain (fan-outs never overlap; a fresh accept during an
 * in-flight run schedules one more). The spawned CLI always reads the
 * *current* backup, so collapsed runs lose nothing.
 */

import { execa } from 'execa';
import {
  parseCredentialsUpdate,
  readCredentialBackup,
  shouldAcceptCredentialUpdate,
  writeCredentialBackup,
  type CredentialAgentKind,
} from '@agentbox/sandbox-core';

/** Mirrors `CREDENTIALS_UPDATED_EVENT` in @agentbox/ctl (like `box-status`). */
export const CREDENTIALS_UPDATED_EVENT = 'credentials-updated';

export interface CredentialsFanoutDeps {
  log: (msg: string) => void;
  /** Debounce before spawning the propagate CLI. Default 3000ms. */
  debounceMs?: number;
  /** Override the fan-out spawn (tests). Default: spawn the host CLI. */
  runPropagate?: (agent: CredentialAgentKind, sourceBoxId: string) => Promise<void>;
  /** Override the per-agent backup path (tests; default: the registry's). */
  backupPathFor?: (agent: CredentialAgentKind) => string;
}

export interface CredentialsHandleResult {
  accepted: boolean;
  reason: string;
}

export class CredentialsFanout {
  private readonly log: (msg: string) => void;
  private readonly debounceMs: number;
  private readonly runPropagate: (agent: CredentialAgentKind, sourceBoxId: string) => Promise<void>;
  private readonly backupPathFor?: (agent: CredentialAgentKind) => string;
  private readonly pending = new Map<CredentialAgentKind, NodeJS.Timeout>();
  private readonly chains = new Map<CredentialAgentKind, Promise<void>>();

  constructor(deps: CredentialsFanoutDeps) {
    this.log = deps.log;
    this.debounceMs = deps.debounceMs ?? 3_000;
    this.runPropagate = deps.runPropagate ?? defaultRunPropagate;
    this.backupPathFor = deps.backupPathFor;
  }

  /**
   * Validate, newest-wins-gate, persist the host backup, and schedule the
   * fan-out. Fast (no box I/O); the propagate CLI does the slow work detached.
   */
  async handle(sourceBoxId: string, payload: unknown): Promise<CredentialsHandleResult> {
    const update = parseCredentialsUpdate(payload);
    if (!update) return { accepted: false, reason: 'invalid payload' };
    const backupPath = this.backupPathFor?.(update.agent);
    const existing = await readCredentialBackup(update.agent, { backupPath });
    const verdict = shouldAcceptCredentialUpdate(update.agent, update.content, existing);
    if (!verdict.accept) {
      return { accepted: false, reason: verdict.reason };
    }
    await writeCredentialBackup(update.agent, update.content, { backupPath });
    this.log(
      `credentials: accepted ${update.agent} update from box ${sourceBoxId} (${verdict.reason}); fan-out in ${String(this.debounceMs)}ms`,
    );
    this.schedule(update.agent, sourceBoxId);
    return { accepted: true, reason: verdict.reason };
  }

  private schedule(agent: CredentialAgentKind, sourceBoxId: string): void {
    const existing = this.pending.get(agent);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(agent);
      const prev = this.chains.get(agent) ?? Promise.resolve();
      const next = prev
        .then(() => this.runPropagate(agent, sourceBoxId))
        .catch((err: unknown) => {
          this.log(
            `credentials: ${agent} fan-out failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      this.chains.set(agent, next);
    }, this.debounceMs);
    timer.unref();
    this.pending.set(agent, timer);
  }

  /** Pending debounce timers + in-flight chain, for tests/shutdown. */
  async flush(): Promise<void> {
    for (const [agent, timer] of this.pending) {
      clearTimeout(timer);
      this.pending.delete(agent);
      void agent;
    }
    await Promise.all([...this.chains.values()]);
  }
}

/**
 * Spawn `agentbox credentials propagate` via the CLI entry the daemon was
 * started with — the CLI owns provider resolution and per-box transports
 * (same pattern as the checkpoint/cp host actions).
 */
async function defaultRunPropagate(
  agent: CredentialAgentKind,
  sourceBoxId: string,
): Promise<void> {
  const entry = process.env['AGENTBOX_CLI_ENTRY'];
  if (!entry) {
    throw new Error('AGENTBOX_CLI_ENTRY not set; cannot run credential propagate host-side');
  }
  const result = await execa(
    process.execPath,
    [entry, 'credentials', 'propagate', '--agent', agent, '--source-box', sourceBoxId],
    { reject: false, timeout: 300_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `credentials propagate exited ${String(result.exitCode)}: ${String(result.stderr).slice(-300)}`,
    );
  }
}
