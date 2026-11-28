// Presentation helpers for custody listings (Files and System pages) — pure so they can be unit-tested
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

// Agent-id → display label, for the per-agent credential rollup the System page
// shows on a control box (mirrors the labels the sync layer uses).
export const CUSTODY_AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export interface AgentCredSummary {
  /** Agent id (second path segment under `agents/`). */
  agent: string;
  label: string;
  /** Files of the agent's own (default) login, `agents/<agent>/<file>`. */
  count: number;
  size: number;
  /** Epoch ms of the most recent write across this agent's entries, or 0. */
  lastUpdate: number;
  /**
   * Named-account objects (`agents/<agent>/accounts/…`), counted apart: they are
   * not the agent's login, so a hub holding only those gives a default box none
   * (#442).
   */
  accounts: number;
}

/**
 * Per-agent rollup of the `agents` custody scope: the honest answer to "what
 * logins will a box created on this control box receive?". Pure.
 */
export function summarizeAgentCredentials(entries: CustodyEntry[]): AgentCredSummary[] {
  const byAgent = new Map<string, { own: CustodyEntry[]; accounts: number }>();
  for (const e of entries) {
    const [scope, agent, third] = e.path.split('/');
    if (scope !== 'agents' || !agent) continue;
    let slot = byAgent.get(agent);
    if (!slot) byAgent.set(agent, (slot = { own: [], accounts: 0 }));
    if (third === 'accounts' && e.path.split('/').length > 3) slot.accounts++;
    else slot.own.push(e);
  }
  return [...byAgent.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([agent, { own, accounts }]) => ({
      agent,
      label: CUSTODY_AGENT_LABELS[agent] ?? agent,
      count: own.length,
      size: own.reduce((n, e) => n + e.size, 0),
      lastUpdate: own.reduce((max, e) => Math.max(max, Date.parse(e.updatedAt) || 0), 0),
      accounts,
    }));
}

/** Human-readable byte size (e.g. `1.4 KB`). Pure — no locale. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** The skills library as the custody manifest shows it, for the System page. */
export interface SkillsSummary {
  /** Stored skills (one `skills/<name>/meta.json` each). */
  count: number;
  /** Bytes of every stored version's tarball. */
  size: number;
  /** Whether the library was ever seeded (`skills/.seeded`). */
  seeded: boolean;
}

export function summarizeSkills(entries: CustodyEntry[]): SkillsSummary {
  let count = 0;
  let size = 0;
  let seeded = false;
  for (const e of entries) {
    if (e.path === 'skills/.seeded') seeded = true;
    else if (/^skills\/[^/]+\/meta\.json$/.test(e.path)) count++;
    else if (/^skills\/[^/]+\/[^/]+\.tar\.gz$/.test(e.path)) size += e.size;
  }
  return { count, size, seeded };
}
