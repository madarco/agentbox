// Presentation helpers for the Custody page — pure so they can be unit-tested
// without the store. Custody entries carry metadata ONLY (path, size, sha256,
// mode, updatedAt); the value bytes never leave the control box, so nothing here
// ever sees a credential. Mirrors the relay's CustodyEntry shape (structural, so
// this stays free of the @agentbox/relay import — the route reaches the store via
// globalThis, like the box backend does).

export interface CustodyEntry {
  /** Custody-relative path, e.g. `agents/claude/.credentials.json`. */
  path: string;
  size: number;
  /** Hex sha256 of the stored bytes. */
  sha256: string;
  /** POSIX mode of the stored value. */
  mode: number;
  /** ISO timestamp of the last write. */
  updatedAt: string;
}

// The four top-level scopes the store enforces (mirrors CUSTODY_SCOPES in the
// relay). Ordered agents → projects → prepared → boxes for display.
export const CUSTODY_SCOPES = ['agents', 'projects', 'prepared', 'boxes'] as const;
export type CustodyScope = (typeof CUSTODY_SCOPES)[number];

export const SCOPE_META: Record<CustodyScope, { label: string; blurb: string }> = {
  agents: {
    label: 'Agent credentials',
    blurb: 'Claude / Codex / OpenCode logins pushed here so a hub-created box is never launched signed-out.',
  },
  projects: {
    label: 'Project seeds',
    blurb: 'Per-project secrets and untracked seed files overlaid onto a fresh clone.',
  },
  prepared: {
    label: 'Prepared bakes',
    blurb: 'Each provider’s base-image bake record, so a base baked on one machine is visible to both.',
  },
  boxes: {
    label: 'Box SSH keys',
    blurb: 'Per-box SSH key material a host minted, so either side can attach / cp / port-forward.',
  },
};

export interface CustodySubgroup {
  /** The second path segment — agent id, project slug, provider, or box id. */
  key: string;
  entries: CustodyEntry[];
  size: number;
}

export interface CustodyScopeGroup {
  scope: CustodyScope;
  label: string;
  blurb: string;
  count: number;
  size: number;
  subgroups: CustodySubgroup[];
}

function isScope(v: string): v is CustodyScope {
  return (CUSTODY_SCOPES as readonly string[]).includes(v);
}

/** The subject key for an entry: the second path segment, with a `.json` bake
 * suffix stripped so `prepared/hetzner.json` groups under `hetzner`. */
export function custodySubject(path: string): string {
  const seg = path.split('/')[1] ?? '';
  return seg.endsWith('.json') ? seg.slice(0, -'.json'.length) : seg;
}

/**
 * Group entries by scope, then by subject (second segment), preserving the fixed
 * scope order. Every scope is returned even when empty so the page can render a
 * complete overview with zero counts. Entries with an unknown scope (which the
 * store cannot produce) are dropped.
 */
export function groupCustody(entries: CustodyEntry[]): CustodyScopeGroup[] {
  const byScope = new Map<CustodyScope, Map<string, CustodyEntry[]>>();
  for (const scope of CUSTODY_SCOPES) byScope.set(scope, new Map());
  for (const entry of entries) {
    const scope = entry.path.split('/')[0] ?? '';
    if (!isScope(scope)) continue;
    const subjects = byScope.get(scope)!;
    const subject = custodySubject(entry.path);
    const list = subjects.get(subject) ?? [];
    list.push(entry);
    subjects.set(subject, list);
  }

  return CUSTODY_SCOPES.map((scope) => {
    const subjects = byScope.get(scope)!;
    const subgroups: CustodySubgroup[] = [...subjects.entries()]
      .map(([key, list]) => ({
        key,
        entries: [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        size: list.reduce((sum, e) => sum + e.size, 0),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const count = subgroups.reduce((n, g) => n + g.entries.length, 0);
    const size = subgroups.reduce((n, g) => n + g.size, 0);
    return { scope, label: SCOPE_META[scope].label, blurb: SCOPE_META[scope].blurb, count, size, subgroups };
  });
}

/** First 12 hex chars — the short fingerprint form used across the CLI. */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** Human-readable byte size (e.g. `1.4 KB`). Pure — no locale. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
