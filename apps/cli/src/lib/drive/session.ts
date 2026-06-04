// Resolve which tmux session inside a box the `drive` subcommands should
// target. The explicit `--session` flag always wins; otherwise we pick the
// first running well-known agent session (claude → codex → opencode) and fall
// back to whatever single session exists if none of those names match.

import type { BoxRecord, Provider } from '@agentbox/core';
import { listSessions } from './tmux.js';

// Mirrors the DEFAULT_*_SESSION constants in `@agentbox/sandbox-docker`. Kept
// inline so this module has no dep on the docker package (it runs against
// any provider).
const AGENT_SESSION_PRIORITY = ['claude', 'codex', 'opencode'] as const;

export interface ResolvedSession {
  name: string;
  /** All sessions tmux reported, in tmux's order. */
  available: string[];
}

export async function resolveDriveSession(
  provider: Provider,
  box: BoxRecord,
  explicit: string | undefined,
): Promise<ResolvedSession> {
  // A paused box has a frozen tmux server, so every drive op would fail with
  // "no agent tmux session". Auto-unpause first (mirrors `agentbox shell`),
  // which is the safety net for a box autopause froze mid-session. The notice
  // goes to stderr so `drive snapshot --json` stdout stays machine-readable.
  if ((await provider.probeState(box)) === 'paused') {
    process.stderr.write(`drive: box ${box.name} is paused; unpausing\n`);
    await provider.resume(box);
  }

  const sessions = await listSessions(provider, box);

  if (explicit !== undefined && explicit !== '') {
    if (!sessions.includes(explicit)) {
      throw new SessionNotFoundError(explicit, sessions);
    }
    return { name: explicit, available: sessions };
  }

  for (const candidate of AGENT_SESSION_PRIORITY) {
    if (sessions.includes(candidate)) {
      return { name: candidate, available: sessions };
    }
  }
  // No agent session, but maybe a custom one started by the user. Auto-pick
  // when there's exactly one to choose from; otherwise fail loud with the list.
  if (sessions.length === 1 && sessions[0]) {
    return { name: sessions[0], available: sessions };
  }
  throw new SessionNotFoundError(undefined, sessions);
}

export class SessionNotFoundError extends Error {
  readonly wanted: string | undefined;
  readonly available: string[];

  constructor(wanted: string | undefined, available: string[]) {
    const head = wanted
      ? `no tmux session '${wanted}' in this box`
      : 'no agent tmux session running in this box';
    const tail = available.length
      ? ` (running: ${available.join(', ')})`
      : ' (tmux server not running or no sessions)';
    super(head + tail);
    this.name = 'SessionNotFoundError';
    this.wanted = wanted;
    this.available = available;
  }
}
