// A faithful copy of @agentbox/relay's normalizeCustodyPath (custody/store.ts):
// validating here gives a clean 400 rather than forwarding a bad path to the
// store. Duplicated rather than imported because a route-level import of
// @agentbox/relay ERR_MODULE_NOT_FOUNDs on execa in the standalone build (the
// same reason the store itself arrives via globalThis — see global.d.ts).
//
// The store re-validates as the real enforcement, so a drift here can only ever
// reject earlier, never let a bad path through. Keep in sync with store.ts if
// the scopes / segment rules change.
//
// Lives in `lib/` so the JSON and blob custody routes share ONE copy: two routes
// each carrying their own would be two places to forget.
const CUSTODY_SCOPES = ['agents', 'projects', 'boxes', 'prepared'];
const AGENT_IDS = ['claude', 'codex', 'opencode'];
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_SEGMENTS = 6;
const MAX_PATH_LENGTH = 256;

export type CustodyPathResult = { ok: true; path: string } | { ok: false; message: string };

export function normalizeCustodyPathSegments(segments: string[]): CustodyPathResult {
  const trimmed = segments.filter((s) => s.length > 0);
  const joined = trimmed.join('/');
  if (joined.length === 0) return { ok: false, message: 'empty custody path' };
  if (joined.length > MAX_PATH_LENGTH) {
    return { ok: false, message: `custody path too long (max ${String(MAX_PATH_LENGTH)} chars)` };
  }
  if (trimmed.length < 2) return { ok: false, message: 'custody path needs a scope and a name' };
  if (trimmed.length > MAX_SEGMENTS) {
    return { ok: false, message: `custody path too deep (max ${String(MAX_SEGMENTS)} segments)` };
  }
  for (const seg of trimmed) {
    if (seg === '.' || seg === '..' || !SEGMENT_RE.test(seg)) {
      return { ok: false, message: `illegal custody path segment: '${seg}'` };
    }
  }
  if (!CUSTODY_SCOPES.includes(trimmed[0]!)) {
    return {
      ok: false,
      message: `unknown custody scope '${trimmed[0]!}' (expected ${CUSTODY_SCOPES.join(' | ')})`,
    };
  }
  if (trimmed[0] === 'agents' && !AGENT_IDS.includes(trimmed[1]!)) {
    return {
      ok: false,
      message: `unknown agent '${trimmed[1]!}' (expected ${AGENT_IDS.join(' | ')})`,
    };
  }
  return { ok: true, path: joined };
}
