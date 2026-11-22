import type { HistoryFrame, HistoryOrigin } from './types.js';

/** Largest frame payload any ingest path accepts (raw bytes). */
export const HISTORY_MAX_FRAME_BYTES = 8 * 1024 * 1024;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Validate an untrusted frame (an RPC param or a request body). The one copy of
 * these rules: the relay, the hub route and the service all go through it.
 * `path` must be relative with no empty or `..` segment: it becomes part of an
 * archive key. Returns null when anything is off.
 */
export function parseHistoryFrame(input: unknown): HistoryFrame | null {
  if (!input || typeof input !== 'object') return null;
  const p = input as Record<string, unknown>;
  if (
    typeof p.agent !== 'string' ||
    !p.agent ||
    typeof p.path !== 'string' ||
    typeof p.offset !== 'number' ||
    !Number.isSafeInteger(p.offset) ||
    p.offset < 0 ||
    typeof p.sha256Prefix !== 'string' ||
    typeof p.sha256 !== 'string' ||
    typeof p.data !== 'string' ||
    p.data.length > Math.ceil(HISTORY_MAX_FRAME_BYTES / 3) * 4
  ) {
    return null;
  }
  if (p.path.startsWith('/') || p.path.split('/').some((s) => s === '..' || s === '')) return null;
  const o = p.origin && typeof p.origin === 'object' ? (p.origin as Record<string, unknown>) : {};
  const origin: HistoryOrigin = {
    boxId: str(o.boxId) ?? '',
    ...(str(o.boxName) ? { boxName: str(o.boxName) } : {}),
    ...(str(o.provider) ? { provider: str(o.provider) } : {}),
    ...(str(o.hostId) ? { hostId: str(o.hostId) } : {}),
    ...(str(o.projectRepoUrl) ? { projectRepoUrl: str(o.projectRepoUrl) } : {}),
  };
  return {
    origin,
    agent: p.agent,
    path: p.path,
    offset: p.offset,
    sha256Prefix: p.sha256Prefix,
    sha256: p.sha256,
    data: p.data,
    ...(p.reset === true ? { reset: true } : {}),
  };
}
