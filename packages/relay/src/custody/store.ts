/**
 * Custody — the control box's copy of what a box needs but the box may not
 * mint for itself: agent login credentials, per-project secrets/envs, and the
 * per-box SSH key material a host minted. The PC stays the source of truth
 * (roadmap §4, "custody + reach"); this is the copy the always-on hub holds so
 * a box created from either side is usable from both.
 *
 * The seam is deliberately **path-and-bytes shaped** — no file handles, no
 * streams, no directory semantics leaking through — so the filesystem backend
 * can be swapped for a blob store (key = path, `sha256` = object metadata)
 * without touching a caller. Payloads are small by construction (credentials,
 * `.env` files, SSH keys); the relay's 1 MiB body cap is the ceiling.
 */

import { createHash } from 'node:crypto';

/** Top-level custody scopes. Anything else is rejected by {@link normalizeCustodyPath}. */
export const CUSTODY_SCOPES = ['agents', 'projects', 'boxes'] as const;
export type CustodyScope = (typeof CUSTODY_SCOPES)[number];

/** Agent ids valid under `agents/` — mirrors `AgentId` in @agentbox/sandbox-core. */
const AGENT_IDS = ['claude', 'codex', 'opencode'] as const;

/** Metadata for one stored entry. `sha256` is the ONLY change signal (never `updatedAt`). */
export interface CustodyEntry {
  /** Custody-relative path, e.g. `agents/claude/.credentials.json`. */
  path: string;
  size: number;
  /** Hex sha256 of the stored bytes. */
  sha256: string;
  /** POSIX mode of the stored value (filesystem backend: 0o600). */
  mode: number;
  /** ISO timestamp of the last *write*. Informational — hash-skipped puts leave it alone. */
  updatedAt: string;
}

/** {@link CustodyStore.put} result. `changed: false` means the bytes were already there. */
export interface CustodyPutResult extends CustodyEntry {
  changed: boolean;
}

export interface CustodyStore {
  /**
   * Store `data` at `path`. Content-addressed skip: when the stored bytes
   * already hash to the same digest, nothing is written and `changed` is false.
   */
  put(path: string, data: Buffer): Promise<CustodyPutResult>;
  /** Fetch bytes + metadata, or null when absent. */
  get(path: string): Promise<{ entry: CustodyEntry; data: Buffer } | null>;
  /** Metadata only (the value never leaves the store). */
  stat(path: string): Promise<CustodyEntry | null>;
  /** The manifest: every entry whose path starts with `prefix` (all entries when omitted). */
  list(prefix?: string): Promise<CustodyEntry[]>;
  /** Remove one entry. Returns false when it wasn't there. */
  delete(path: string): Promise<boolean>;
}

/** A rejected custody path (bad scope, traversal, illegal segment). Handlers map this to 400. */
export class CustodyPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustodyPathError';
  }
}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_SEGMENTS = 6;
const MAX_PATH_LENGTH = 256;

/** Hex sha256 of `data` — the store's change signal and the CLI's skip check. */
export function custodyDigest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Validate + canonicalize a custody path. Fail-closed: every segment must be a
 * plain name (`.`/`..` and separators rejected, so no traversal can escape the
 * root even before the backend resolves it), the first segment must be a known
 * scope, and `agents/` accepts only the three known agent ids.
 */
export function normalizeCustodyPath(raw: string): string {
  const trimmed = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0) throw new CustodyPathError('empty custody path');
  if (trimmed.length > MAX_PATH_LENGTH) {
    throw new CustodyPathError(`custody path too long (max ${String(MAX_PATH_LENGTH)} chars)`);
  }
  const segments = trimmed.split('/');
  if (segments.length < 2) {
    throw new CustodyPathError(`custody path needs a scope and a name: '${raw}'`);
  }
  if (segments.length > MAX_SEGMENTS) {
    throw new CustodyPathError(`custody path too deep (max ${String(MAX_SEGMENTS)} segments)`);
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || !SEGMENT_RE.test(seg)) {
      throw new CustodyPathError(`illegal custody path segment: '${seg}'`);
    }
  }
  const scope = segments[0] as CustodyScope;
  if (!CUSTODY_SCOPES.includes(scope)) {
    throw new CustodyPathError(
      `unknown custody scope '${scope}' (expected ${CUSTODY_SCOPES.join(' | ')})`,
    );
  }
  if (scope === 'agents' && !(AGENT_IDS as readonly string[]).includes(segments[1]!)) {
    throw new CustodyPathError(
      `unknown agent '${segments[1]!}' (expected ${AGENT_IDS.join(' | ')})`,
    );
  }
  return segments.join('/');
}

/**
 * Validate a manifest prefix. Looser than a full path (a bare scope like
 * `agents` or a partial `boxes/abc` is legal) but the same anti-traversal rules
 * apply, so a listing can never walk out of the root.
 */
export function normalizeCustodyPrefix(raw: string): string {
  const trimmed = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0) return '';
  if (trimmed.length > MAX_PATH_LENGTH) {
    throw new CustodyPathError(`custody prefix too long (max ${String(MAX_PATH_LENGTH)} chars)`);
  }
  const segments = trimmed.split('/');
  if (segments.length > MAX_SEGMENTS) {
    throw new CustodyPathError(`custody prefix too deep (max ${String(MAX_SEGMENTS)} segments)`);
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || !SEGMENT_RE.test(seg)) {
      throw new CustodyPathError(`illegal custody prefix segment: '${seg}'`);
    }
  }
  if (!CUSTODY_SCOPES.includes(segments[0] as CustodyScope)) {
    throw new CustodyPathError(
      `unknown custody scope '${segments[0]!}' (expected ${CUSTODY_SCOPES.join(' | ')})`,
    );
  }
  return segments.join('/');
}
