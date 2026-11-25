// The Files page's view model (Settings → Files): the custody manifest regrouped
// for people rather than by store prefix. Pure, so it unit-tests without a store.
//
// Input is metadata only (path, size, sha256, mtime) from GET /api/v1/custody;
// the joins (project names, account labels, box names, machine labels) come from
// payloads the page already has (`useStore()` projects + boxes, GET /accounts).
// Nothing here ever sees a file's bytes.

import { CUSTODY_AGENT_LABELS, type CustodyEntry } from './custody-view';

export type FilesGroupId = 'projects' | 'agents' | 'skills' | 'prepared' | 'boxes';

export interface FilesRow {
  key: string;
  title: string;
  /** Secondary text: what the row is (seed, default login, SSH key …). */
  detail?: string;
  /** Monospace hint, e.g. the custody file names a row rolls up. */
  hint?: string;
  files: number;
  size: number;
  /** Epoch ms of the newest write among the row's files (0 = unknown). */
  updatedAt: number;
  href?: string;
}

export interface FilesSection {
  key: string;
  title: string;
  /** Shown next to the title in mono, e.g. the custody slug. */
  subtitle?: string;
  href?: string;
  /** Hub projects that share this section's files (one repo, several folders). */
  projects?: { id: string; name: string; href: string }[];
  rows: FilesRow[];
}

export interface FilesGroup {
  id: FilesGroupId;
  label: string;
  blurb: string;
  /** Number of custody entries in the group. */
  count: number;
  size: number;
  sections: FilesSection[];
  /** A page that manages what the group holds. */
  link?: { href: string; label: string };
}

/** What the page joins custody keys against. Every field is optional. */
export interface FilesJoin {
  projects?: readonly {
    id: string;
    name: string;
    repo?: string;
    originUrl?: string | null;
    projectSlug?: string | null;
  }[];
  boxes?: readonly {
    id: string;
    task?: string;
    sandboxId?: string;
    originMachineId?: string;
    originMachineLabel?: string;
  }[];
  accounts?: readonly { agent: string; id: string; label?: string }[];
}

const GROUP_META: Record<FilesGroupId, { label: string; blurb: string }> = {
  projects: {
    label: 'Project files',
    blurb:
      'Seeds and secrets pushed for a project (agentbox hub project push) and files copied with agentbox cp, carried into that project’s boxes.',
  },
  agents: {
    label: 'Agent logins',
    blurb:
      'The login each agent account starts with, so a box created here is never signed out. Shown by account; the credentials themselves never leave the hub.',
  },
  skills: {
    label: 'Skills library',
    blurb: 'The skills every box receives, one archive per version.',
  },
  prepared: {
    label: 'Bakes',
    blurb:
      'Each provider’s base-image bake record, so a base baked on one machine is used by both.',
  },
  boxes: {
    label: 'Box keys',
    blurb: 'Per-box material: the SSH key a host minted for the box, and the skills it was served.',
  },
};

export const FILES_GROUP_ORDER: readonly FilesGroupId[] = [
  'projects',
  'agents',
  'skills',
  'prepared',
  'boxes',
];

const ACCOUNTS_SEGMENT = 'accounts';

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function rollup(
  key: string,
  title: string,
  entries: readonly CustodyEntry[],
  extra: Partial<FilesRow> = {},
): FilesRow {
  return {
    key,
    title,
    files: entries.length,
    size: entries.reduce((n, e) => n + e.size, 0),
    updatedAt: entries.reduce((m, e) => Math.max(m, ms(e.updatedAt)), 0),
    ...extra,
  };
}

function byKey<T extends { key: string }>(a: T, b: T): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function bucket(entries: readonly CustodyEntry[], keyOf: (e: CustodyEntry) => string | null) {
  const out = new Map<string, CustodyEntry[]>();
  for (const e of entries) {
    const k = keyOf(e);
    if (k === null) continue;
    const list = out.get(k) ?? [];
    list.push(e);
    out.set(k, list);
  }
  return out;
}

// ── Projects ────────────────────────────────────────────────────────────────

/**
 * A custody project slug read back for people: `github.com__acme__web` →
 * `{host: 'github.com', path: 'acme/web'}`; a legacy `acme__web` → path only.
 * A lossy slug's `-<16 hex>` digest suffix is dropped (display only).
 */
export function readProjectSlug(slug: string): { host?: string; path: string } {
  const bare = slug.replace(/-[0-9a-f]{16}$/, '');
  const segs = bare.split('__').filter((s) => s.length > 0);
  if (segs.length >= 3 && segs[0]!.includes('.')) {
    return { host: segs[0], path: segs.slice(1).join('/') };
  }
  return { path: segs.join('/') || slug };
}

/** `owner/repo` path of a git remote URL (https, ssh, scp-like), or null. */
export function originPath(url: string): string | null {
  const s = url
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const scp = /^[^@/]+@[^:/]+:(.+)$/.exec(s);
  if (scp) return scp[1]!.replace(/^\/+/, '');
  try {
    return new URL(s).pathname.replace(/^\/+/, '') || null;
  } catch {
    return null;
  }
}

/**
 * The hub projects a custody slug belongs to: the one that registered that
 * slug, else every project whose origin has the slug's path (one repo can be
 * several project folders), else the only project whose folder name is the
 * slug's repo name. Empty when none (or more than one by name alone) matches.
 */
export function matchProjects<P extends NonNullable<FilesJoin['projects']>[number]>(
  slug: string,
  projects: readonly P[],
): P[] {
  const exact = projects.find((p) => p.projectSlug === slug);
  if (exact) return [exact];
  const { path } = readProjectSlug(slug);
  const byOrigin = projects.filter((p) => p.originUrl && originPath(p.originUrl) === path);
  if (byOrigin.length) return byOrigin;
  const name = path.split('/').pop() ?? path;
  const byName = projects.filter((p) => (p.repo ?? p.name) === name || p.name === name);
  return byName.length === 1 ? byName : [];
}

function projectFileDetail(rel: string): string | undefined {
  const head = rel.split('/')[0];
  if (head === 'seed') return 'Seed';
  if (head === 'cp') return 'Copied in';
  if (head === 'cp-out') return 'Copied out';
  return undefined;
}

function projectSections(entries: readonly CustodyEntry[], join: FilesJoin): FilesSection[] {
  const bySlug = bucket(entries, (e) => e.path.split('/')[1] ?? null);
  return [...bySlug.entries()]
    .map(([slug, list]): FilesSection => {
      const matched = matchProjects(slug, join.projects ?? []);
      const project = matched.length === 1 ? matched[0] : undefined;
      const read = readProjectSlug(slug);
      const rows = list
        .map((e) => {
          const rel = e.path.split('/').slice(2).join('/');
          return rollup(e.path, rel, [e], { detail: projectFileDetail(rel) });
        })
        .sort(byKey);
      return {
        key: slug,
        title: project?.name ?? read.path,
        subtitle: read.host ? `${read.host}/${read.path}` : read.path,
        href: project ? `/projects/${encodeURIComponent(project.id)}` : undefined,
        projects:
          matched.length > 1
            ? matched.map((p) => ({
                id: p.id,
                name: p.name,
                href: `/projects/${encodeURIComponent(p.id)}`,
              }))
            : undefined,
        rows,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ── Agent logins ────────────────────────────────────────────────────────────

function agentSections(entries: readonly CustodyEntry[], join: FilesJoin): FilesSection[] {
  const byAgent = bucket(entries, (e) => e.path.split('/')[1] ?? null);
  const machineLabels = new Map<string, string>();
  for (const b of join.boxes ?? []) {
    if (b.originMachineId && b.originMachineLabel) {
      machineLabels.set(b.originMachineId, b.originMachineLabel);
    }
  }
  return [...byAgent.entries()]
    .map(([agent, list]): FilesSection => {
      // agents/<agent>/<file>                               → the default login
      // agents/<agent>/accounts/<machine>/<id>/<file>       → a named account
      const rows = new Map<string, CustodyEntry[]>();
      for (const e of list) {
        const parts = e.path.split('/');
        const key =
          parts[2] === ACCOUNTS_SEGMENT && parts.length >= 6
            ? `${parts[3]!}/${parts[4]!}`
            : 'default';
        rows.set(key, [...(rows.get(key) ?? []), e]);
      }
      const out = [...rows.entries()].map(([key, files]) => {
        const hint = files.map((f) => f.path.split('/').pop()).join(', ');
        if (key === 'default') {
          return rollup(`${agent}/default`, 'Default', files, { detail: 'Default login', hint });
        }
        const [machine, id] = key.split('/') as [string, string];
        const label = join.accounts?.find((a) => a.agent === agent && a.id === id)?.label;
        const machineName = machineLabels.get(machine) ?? machine.slice(0, 12);
        return rollup(`${agent}/${key}`, label ?? id, files, {
          detail: label && label !== id ? `${id} · from ${machineName}` : `from ${machineName}`,
          hint,
          href: '/settings/subscriptions',
        });
      });
      // Default first, then accounts by title.
      out.sort((a, b) =>
        a.title === 'Default' ? -1 : b.title === 'Default' ? 1 : a.title.localeCompare(b.title),
      );
      return { key: agent, title: CUSTODY_AGENT_LABELS[agent] ?? agent, rows: out };
    })
    .sort(byKey);
}

// ── Skills ──────────────────────────────────────────────────────────────────

function skillSections(entries: readonly CustodyEntry[]): FilesSection[] {
  const bySkill = bucket(entries, (e) => {
    const parts = e.path.split('/');
    // `skills/.seeded` and other top-level markers are bookkeeping, not skills.
    return parts.length >= 3 ? parts[1]! : null;
  });
  const rows = [...bySkill.entries()]
    .map(([name, files]) => {
      const versions = files.filter((f) => f.path.endsWith('.tar.gz')).length;
      return rollup(name, name, files, {
        detail: versions === 1 ? '1 version' : `${String(versions)} versions`,
        href: '/settings/skills',
      });
    })
    .sort(byKey);
  return rows.length ? [{ key: 'skills', title: 'Skills', rows }] : [];
}

// ── Bakes ───────────────────────────────────────────────────────────────────

function bakeSections(entries: readonly CustodyEntry[]): FilesSection[] {
  const byProvider = bucket(entries, (e) => (e.path.split('/')[1] ?? '').replace(/\.json$/, ''));
  const rows = [...byProvider.entries()]
    .map(([provider, files]) =>
      rollup(provider, provider, files, { detail: 'Base image record', href: '/settings/system' }),
    )
    .sort(byKey);
  return rows.length ? [{ key: 'prepared', title: 'Providers', rows }] : [];
}

// ── Box keys ────────────────────────────────────────────────────────────────

function boxFileKind(rel: string): string {
  const head = rel.split('/')[0];
  if (head === 'ssh' || /^id_/.test(rel)) return 'SSH key';
  if (rel === 'skills.json') return 'Served skills';
  if (head === 'cp' || head === 'cp-out') return 'Copied files';
  return rel;
}

function boxSections(entries: readonly CustodyEntry[], join: FilesJoin): FilesSection[] {
  const byBox = bucket(entries, (e) => e.path.split('/')[1] ?? null);
  const rows = [...byBox.entries()]
    .map(([key, files]) => {
      const box = (join.boxes ?? []).find((b) => b.id === key || b.sandboxId === key);
      const kinds = [
        ...new Set(files.map((f) => boxFileKind(f.path.split('/').slice(2).join('/')))),
      ];
      return rollup(key, box ? box.id : key, files, {
        detail: box
          ? [box.task, kinds.join(', ')].filter(Boolean).join(' · ')
          : `${kinds.join(', ')} · box no longer listed`,
        hint: box?.sandboxId && box.sandboxId !== box.id ? box.sandboxId : undefined,
        href: box ? `/boxes/${encodeURIComponent(box.id)}` : undefined,
      });
    })
    .sort(byKey);
  return rows.length ? [{ key: 'boxes', title: 'Boxes', rows }] : [];
}

// ── Assembly ────────────────────────────────────────────────────────────────

/**
 * Regroup the custody manifest into the Files page's five groups, always in
 * {@link FILES_GROUP_ORDER} and always all five (empty ones included, so the
 * overview is complete). An entry under an unknown scope is dropped.
 */
export function buildFilesView(
  entries: readonly CustodyEntry[],
  join: FilesJoin = {},
): FilesGroup[] {
  const byScope = bucket(entries, (e) => {
    const scope = e.path.split('/')[0] ?? '';
    return (FILES_GROUP_ORDER as readonly string[]).includes(scope) ? scope : null;
  });
  return FILES_GROUP_ORDER.map((id) => {
    const list = byScope.get(id) ?? [];
    const sections =
      id === 'projects'
        ? projectSections(list, join)
        : id === 'agents'
          ? agentSections(list, join)
          : id === 'skills'
            ? skillSections(list)
            : id === 'prepared'
              ? bakeSections(list)
              : boxSections(list, join);
    return {
      id,
      ...GROUP_META[id],
      count: list.length,
      size: list.reduce((n, e) => n + e.size, 0),
      sections,
      link: id === 'skills' ? { href: '/settings/skills', label: 'Open Skills' } : undefined,
    };
  });
}
