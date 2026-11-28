// The ctl credentials watcher's `credentials-dead` event: a box's agent login
// file turned into its signed-out shape (claude wipes its tokens after a
// refresh it cannot make). Recorded as auth evidence on the account the box
// runs on, with no turn needed (docs/credentials-tui-plan.md, Phase 4). The
// payload carries no secret; it still stays out of a host relay's event ring,
// where nothing reads it.
import type { CredentialsDeadEvent, HistoryIngestSink } from '@agentbox/core';

/** Mirrors `CREDENTIALS_DEAD_EVENT` in @agentbox/ctl. */
export const CREDENTIALS_DEAD_EVENT = 'credentials-dead';
/**
 * Mirrors `CREDENTIALS_ALIVE_EVENT` in @agentbox/ctl: the box holds a real
 * login (after a reported wipe, or on ctl's first read). Its own event, so a
 * relay that does not know it ignores it rather than reading a refusal.
 */
export const CREDENTIALS_ALIVE_EVENT = 'credentials-alive';

/**
 * A `credentials-dead` (`{ schema: 1, agent, wipedAt }`) or `credentials-alive`
 * (`{ schema: 1, agent, at }`) payload, or null when it is not one. Pure.
 */
export function parseCredentialsDead(
  payload: unknown,
  alive = false,
): { agent: string; at: string; alive: boolean } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p['schema'] !== 1) return null;
  const agent = p['agent'];
  const at = alive ? p['at'] : p['wipedAt'];
  if (typeof agent !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(agent)) return null;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  return { agent, at: new Date(Date.parse(at)).toISOString(), alive };
}

/**
 * Hand a box's `credentials-dead` / `credentials-alive` event to the hub's
 * auth evidence. The box's own time is clamped to `now`: a box clock ahead
 * must not date its evidence past a later renew. Returns the verdict for the
 * relay's log line. Never throws.
 */
export async function handleCredentialsDead(
  sink: HistoryIngestSink | undefined,
  box: { boxId: string; name?: string },
  payload: unknown,
  opts: { alive?: boolean; now?: number } = {},
): Promise<{ recorded: boolean; reason: string }> {
  const parsed = parseCredentialsDead(payload, opts.alive === true);
  if (!parsed) return { recorded: false, reason: 'invalid payload' };
  if (!sink?.recordCredentialsDead) return { recorded: false, reason: 'no hub auth evidence here' };
  const now = opts.now ?? Date.now();
  const ts = Date.parse(parsed.at) > now ? new Date(now).toISOString() : parsed.at;
  const e: CredentialsDeadEvent = {
    boxId: box.boxId,
    ...(box.name ? { boxName: box.name } : {}),
    agent: parsed.agent,
    ts,
    ...(parsed.alive ? { alive: true } : {}),
  };
  try {
    await sink.recordCredentialsDead(e);
    return {
      recorded: true,
      reason: `${parsed.agent} ${parsed.alive ? 'holds a real login' : 'wiped'} at ${ts}`,
    };
  } catch (err) {
    return { recorded: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
