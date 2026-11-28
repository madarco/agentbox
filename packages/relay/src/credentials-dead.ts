// The ctl credentials watcher's `credentials-dead` event: a box's agent login
// file turned into its signed-out shape (claude wipes its tokens after a
// refresh it cannot make). Recorded as auth evidence on the account the box
// runs on, with no turn needed (docs/credentials-tui-plan.md, Phase 4). The
// payload carries no secret; it still stays out of a host relay's event ring,
// where nothing reads it.
import type { CredentialsDeadEvent, HistoryIngestSink } from '@agentbox/core';

/** Mirrors `CREDENTIALS_DEAD_EVENT` in @agentbox/ctl. */
export const CREDENTIALS_DEAD_EVENT = 'credentials-dead';

/** The event's payload, or null when it is not one. Pure. */
export function parseCredentialsDead(
  payload: unknown,
): { agent: string; wipedAt: string; alive: boolean } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p['schema'] !== 1) return null;
  const agent = p['agent'];
  const wipedAt = p['wipedAt'];
  if (typeof agent !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(agent)) return null;
  if (typeof wipedAt !== 'string' || !Number.isFinite(Date.parse(wipedAt))) return null;
  return {
    agent,
    wipedAt: new Date(Date.parse(wipedAt)).toISOString(),
    alive: p['alive'] === true,
  };
}

/**
 * Hand a box's `credentials-dead` event to the hub's auth evidence. Returns
 * the verdict for the relay's log line. Never throws.
 */
export async function handleCredentialsDead(
  sink: HistoryIngestSink | undefined,
  box: { boxId: string; name?: string },
  payload: unknown,
): Promise<{ recorded: boolean; reason: string }> {
  const parsed = parseCredentialsDead(payload);
  if (!parsed) return { recorded: false, reason: 'invalid payload' };
  if (!sink?.recordCredentialsDead) return { recorded: false, reason: 'no hub auth evidence here' };
  const e: CredentialsDeadEvent = {
    boxId: box.boxId,
    ...(box.name ? { boxName: box.name } : {}),
    agent: parsed.agent,
    ts: parsed.wipedAt,
    ...(parsed.alive ? { alive: true } : {}),
  };
  try {
    await sink.recordCredentialsDead(e);
    return {
      recorded: true,
      reason: `${parsed.agent} ${parsed.alive ? 'signed in again' : 'wiped'} at ${parsed.wipedAt}`,
    };
  } catch (err) {
    return { recorded: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
