// Who is calling, for the timeline. The CLI sends `X-AgentBox-Session:
// <agent>:<sessionId>` when it runs inside a host agent session; the hub resolves
// that to a registered manager (no write) and stamps the manager's current turn.
// No header — the tray, the web UI, a plain script — is a human.
import type { HubBackend, TimelineMeta, TimelineSessionRef } from '@/lib/boxes/backend-types';
import type { TimelineStamp } from '@/lib/boxes/types';

export const SESSION_HEADER = 'x-agentbox-session';
/**
 * `<turn>[;<prompt>]`, the prompt percent-encoded. Client-asserted like the
 * session header: the backend uses it only for a manager whose transcript is on
 * another machine, and ignores it entirely when it can read the transcript here.
 */
export const SESSION_TURN_HEADER = 'x-agentbox-session-turn';

const SESSION_VALUE_RE = /^([a-z0-9][a-z0-9_-]{0,31}):([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const SESSION_TURN_RE = /^(\d{1,9})(?:;(.*))?$/s;

const HUMAN: TimelineStamp = { actor: 'human' };

export async function sessionActor(
  req: Request,
  backend: Pick<HubBackend, 'timelineStamp'>,
  wsId?: string,
): Promise<TimelineStamp> {
  const ref = sessionRef(req);
  if (!ref) return HUMAN;
  const stamp = await backend.timelineStamp(ref, wsId).catch(() => undefined);
  return stamp ?? HUMAN;
}

function sessionRef(req: Request): TimelineSessionRef | undefined {
  const raw = req.headers.get(SESSION_HEADER)?.trim();
  const m = raw ? SESSION_VALUE_RE.exec(raw) : null;
  if (!m) return undefined;
  return { agent: m[1]!, sessionId: m[2]!, ...reportedTurn(req) };
}

/** The turn the caller read from its own transcript, when it sent a usable one. */
function reportedTurn(req: Request): { turn?: number; prompt?: string } {
  const raw = req.headers.get(SESSION_TURN_HEADER)?.trim();
  const m = raw ? SESSION_TURN_RE.exec(raw) : null;
  if (!m) return {};
  const turn = Number(m[1]);
  if (!Number.isInteger(turn) || turn < 1) return {};
  let prompt: string | undefined;
  try {
    prompt = m[2] ? decodeURIComponent(m[2]) : undefined;
  } catch {
    // A malformed escape: the turn is still usable, the prompt is not.
    prompt = undefined;
  }
  return { turn, ...(prompt ? { prompt } : {}) };
}

/**
 * With `wsId`, the caller resolved to a manager of that workspace. Without one
 * (box and manager routes) only the session is carried: the backend learns the
 * workspace from the box or manager and resolves it there, so a manager of
 * another workspace is never stamped into this one's log.
 */
export async function timelineMeta(
  req: Request,
  backend: Pick<HubBackend, 'timelineStamp'>,
  opts: { wsId?: string; note?: string } = {},
): Promise<TimelineMeta> {
  const note = opts.note ? { note: opts.note } : {};
  if (opts.wsId === undefined) {
    const session = sessionRef(req);
    return { ...(session ? { session } : { stamp: HUMAN }), ...note };
  }
  return { stamp: await sessionActor(req, backend, opts.wsId), ...note };
}
