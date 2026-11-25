/**
 * The hub <-> PC skills comparison (docs/hub-settings-plan.md, Phase 2). One
 * implementation for the CLI's `agentbox skills` TUI and the hub's skills page
 * (which asks the PC's relay for its inventory), so both say the same thing
 * about the same skill.
 */
import { allAgentSpecs } from '@agentbox/agent-registry';

export type SkillRowStatus = 'same' | 'differs' | 'local-only' | 'hub-only';

/** What the comparison reads of a PC skill. */
export interface CompareLocal {
  name: string;
  treeSha: string;
  newestMtimeMs: number;
}

/** What the comparison reads of a hub skill. */
export interface CompareHub {
  name: string;
  current: string;
  updatedAt: string;
}

export interface CompareRow<L extends CompareLocal, H extends CompareHub> {
  name: string;
  local?: L;
  hub?: H;
  status: SkillRowStatus;
  /** For `differs`: which side changed last (local file mtime vs hub upload time). */
  newer?: 'local' | 'hub';
}

/** PC and hub skills side by side, matched by name, sorted by name. */
export function compareSkills<L extends CompareLocal, H extends CompareHub>(
  local: readonly L[],
  hub: readonly H[],
): CompareRow<L, H>[] {
  const rows = new Map<string, CompareRow<L, H>>();
  for (const l of local) rows.set(l.name, { name: l.name, local: l, status: 'local-only' });
  for (const h of hub) {
    const row = rows.get(h.name);
    if (!row) {
      rows.set(h.name, { name: h.name, hub: h, status: 'hub-only' });
      continue;
    }
    row.hub = h;
    if (row.local!.treeSha === h.current) {
      row.status = 'same';
    } else {
      row.status = 'differs';
      // An unread local copy (too big, unreadable: no tree hash) has no age to
      // compare, so neither side is called newer.
      if (row.local!.treeSha !== '') {
        row.newer = row.local!.newestMtimeMs > Date.parse(h.updatedAt) ? 'local' : 'hub';
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** An agent and the home-relative skill dirs it reads on a PC (`skills.dirs`). */
export interface AgentSkillDirs {
  id: string;
  dirs: readonly string[];
}

/** Every registry agent that declares PC skill dirs (plugin agents included). */
export function agentSkillDirs(): AgentSkillDirs[] {
  return allAgentSpecs()
    .filter((s) => (s.skills?.dirs.length ?? 0) > 0)
    .map((s) => ({ id: s.id, dirs: s.skills!.dirs }));
}

/**
 * The agents that read a skill held in these home-relative dirs: an agent
 * counts when any of the dirs is one of its own (`~/.agents/skills` is every
 * agent that reads it). Information only: delivery to boxes is global.
 */
export function agentsForSkillDirs(
  dirs: readonly string[],
  agents: readonly AgentSkillDirs[] = agentSkillDirs(),
): string[] {
  const want = new Set(dirs.map(trimSlashes));
  return agents.filter((a) => a.dirs.some((d) => want.has(trimSlashes(d)))).map((a) => a.id);
}

/**
 * The home-relative skill dir an absolute skill path sits in (`/Users/m/.agents/skills/x`
 * -> `.agents/skills`), matched against the known dirs; null when it is none of them
 * (an imported folder elsewhere on the PC).
 */
export function skillDirOfPath(
  path: string,
  name: string,
  agents: readonly AgentSkillDirs[] = agentSkillDirs(),
): string | null {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const known = [...new Set(agents.flatMap((a) => a.dirs.map(trimSlashes)))].sort(
    (a, b) => b.length - a.length,
  );
  for (const d of known) {
    if (p.endsWith(`/${d}/${name}`)) return d;
  }
  return null;
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}
