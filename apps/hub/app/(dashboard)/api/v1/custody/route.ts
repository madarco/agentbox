// GET /api/v1/custody — the control box's custody manifest: paths + hashes +
// sizes + mtimes for the agent credentials, project seeds, bake records, and
// per-box SSH keys it holds. VALUES ARE NEVER RETURNED — same contract as
// `agentbox hub custody list` and the relay's /admin/custody. Read-only.
//
// `?prefix=<scope|scope/subject>` scopes the listing (e.g. `agents`,
// `boxes/box-abc`). Reaches the store through globalThis (set by the custom
// server) so @agentbox/relay stays out of Next's bundle, and reports
// `enabled: false` when custody isn't wired here (a hub with no admin token).
import { fail, ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Same anti-traversal shape the store enforces (mirrors normalizeCustodyPrefix):
// a bare scope or `scope/subject`, plain segments only. We reject a malformed
// prefix here with a 400 rather than forwarding it.
const PREFIX_RE = /^(agents|projects|prepared|boxes)(\/[A-Za-z0-9._-]+)*$/;

export async function GET(req: Request): Promise<Response> {
  const custody = globalThis.__AGENTBOX_HUB_CUSTODY;
  if (!custody) {
    // Not an error — a localhost hub simply holds no custody. The page renders
    // an explanatory empty state.
    return ok({ enabled: false, entries: [] });
  }

  const rawPrefix = new URL(req.url).searchParams.get('prefix');
  let prefix: string | undefined;
  if (rawPrefix) {
    if (!PREFIX_RE.test(rawPrefix)) {
      return fail('invalid_request', 'prefix must be a custody scope or scope/subject');
    }
    prefix = rawPrefix;
  }

  try {
    const entries = await custody.list(prefix);
    return ok({ enabled: true, entries });
  } catch (err) {
    return fail('internal', err instanceof Error ? err.message : 'custody list failed');
  }
}
