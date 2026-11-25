// The Files page's view model (Settings → Files): the custody manifest regrouped
// for people rather than by store prefix. Pure, so it unit-tests without a store.
//
// Input is metadata only (path, size, sha256, mtime) from GET /api/v1/custody;
// the joins (project names, account labels, box names, machine labels) come from
// payloads the page already has (`useStore()` projects + boxes, GET /accounts,
// GET /devices). Nothing here ever sees a file's bytes.

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
  /** Shown next to the title in mono, e.g. the repo a project slug names. */
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
  /** Files the group's rows show (bookkeeping markers excluded). */
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
  /** This hub machine's accounts; labels apply only to entries of `machine`. */
  accounts?: readonly { agent: string; id: string; label?: string }[];
  /** The machine `accounts` belong to (GET /accounts `machine`). */
  machine?: string;
  /** Machine id → name (enrolled devices). */
  machines?: readonly { id: string; label: string }[];
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

function bucket(
  entries: readonly CustodyEntry[],
  keyOf: (e: CustodyEntry) => string | null,
): Map<string, CustodyEntry[]> {
  const out = new Map<string, CustodyEntry[]>();
  for (const e of entries) {
    const k = keyOf(e);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(e);
    else out.set(k, [e]);
  }
  return out;
}

const segs = (e: CustodyEntry): string[] => e.path.split('/');

// ── Projects ────────────────────────────────────────────────────────────────

/**
 * A custody project slug read back for people: `github.com__acme__web` →
 * `{host: 'github.com', path: 'acme/web'}`; a legacy `acme__web` → path only.
 * A lossy slug's `-<16 hex>` digest suffix is dropped (display only).
 */
export function readProjectSlug(slug: string): { host?: string; path: string } {
  const bare = slug.replace(/-[0-9a-f]{16}$/, '');
  const parts = bare.split('__').filter((s) => s.length > 0);
  if (parts.length >= 3 && parts[0]!.includes('.')) {
    return { host: parts[0], path: parts.slice(1).join('/') };
  }
  return { path: parts.join('/') || slug };
}

/**
 * Host and `owner/repo` path of a git remote URL (https, ssh, scp-like),
 * lowercased like the repo key custody slugs are made from; null when unparsable.
 */
export function originKey(url: string): { host: string; path: string } | null {
  const s = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(s);
  let host: string;
  let path: string;
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const u = new URL(s);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+/, '');
  if (!host || !path) return null;
  return { host: host.toLowerCase(), path: path.toLowerCase() };
}

/**
 * The hub projects a custody slug belongs to: those that registered that slug,
 * else every project whose origin is the slug's repo (one repo can be several
 * project folders), else the only project with no known origin whose folder
 * name is the slug's repo name. Empty when none matches.
 */
export function matchProjects<P extends NonNullable<FilesJoin['projects']>[number]>(
  slug: string,
  projects: readonly P[],
): P[] {
  const exact = projects.filter((p) => p.projectSlug === slug);
  if (exact.length) return exact;
  const read = readProjectSlug(slug);
  const path = read.path.toLowerCase();
  const host = read.host?.toLowerCase();
  const byOrigin = projects.filter((p) => {
    const o = p.originUrl ? originKey(p.originUrl) : null;
    return o !== null && o.path === path && (host === undefined || o.host === host);
  });
  if (byOrigin.length) return byOrigin;
  // A folder name alone is weak evidence: only for a project whose origin and
  // slug are unknown, and only when exactly one matches.
  const name = path.split('/').pop() ?? path;
  const byName = projects.filter(
    (p) =>
      !p.originUrl &&
      !p.projectSlug &&
      ((p.repo ?? p.name).toLowerCase() === name || p.name.toLowerCase() === name),
  );
  return byName.length === 1 ? byName : [];
}

function projectRows(list: readonly CustodyEntry[]): FilesRow[] {
  // Seed files are few and each matters, so one row per file; copied files can
  // be many, so `cp/` and `cp-out/` roll up to one row each.
  const rolled = bucket(list, (e) => {
    const head = segs(e)[2];
    return head === 'cp' || head === 'cp-out' ? head : null;
  });
  const rows: FilesRow[] = [];
  for (const e of list) {
    const head = segs(e)[2];
    if (head === 'cp' || head === 'cp-out') continue;
    const rel = segs(e).slice(2).join('/');
    rows.push(rollup(e.path, rel, [e], head === 'seed' ? { detail: 'Seed' } : {}));
  }
  for (const [head, files] of rolled) {
    rows.push(
      rollup(head, `${head}/`, files, {
        detail: head === 'cp' ? 'Copied in with agentbox cp' : 'Copied out with agentbox cp',
      }),
    );
  }
  return rows.sort(byKey);
}

function projectSections(entries: readonly CustodyEntry[], join: FilesJoin): FilesSection[] {
  const bySlug = bucket(entries, (e) => segs(e)[1] ?? null);
  return [...bySlug.entries()]
    .map(([slug, list]): FilesSection => {
      const matched = matchProjects(slug, join.projects ?? []);
      const project = matched.length === 1 ? matched[0] : undefined;
      const read = readProjectSlug(slug);
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
        rows: projectRows(list),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ── Agent logins ────────────────────────────────────────────────────────────

function agentSections(entries: readonly CustodyEntry[], join: FilesJoin): FilesSection[] {
  const machineNames = new Map<string, string>();
  for (const b of join.boxes ?? []) {
    if (b.originMachineId && b.originMachineLabel) {
      machineNames.set(b.originMachineId, b.originMachineLabel);
    }
  }
  for (const m of join.machines ?? []) machineNames.set(m.id, m.label);
  // Labels are this hub machine's: another PC's `work` is a different account.
  const labels = new Map<string, string>();
  if (join.machine) {
    for (const a of join.accounts ?? []) {
      if (a.label) labels.set(`${join.machine}/${a.agent}/${a.id}`, a.label);
    }
  }

  const byAgent = bucket(entries, (e) => segs(e)[1] ?? null);
  return [...byAgent.entries()]
    .map(([agent, list]): FilesSection => {
      // agents/<agent>/<file>                           → the default login
      // agents/<agent>/accounts/<machine>/<id>/<file>   → a named account
      const byAccount = bucket(list, (e) => {
        const p = segs(e);
        return p[2] === ACCOUNTS_SEGMENT && p.length >= 6 ? `${p[3]!}/${p[4]!}` : 'default';
      });
      const rows = [...byAccount.entries()].map(([key, files]) => {
        const hint = files.map((f) => segs(f).pop()).join(', ');
        if (key === 'default') {
          return rollup(`${agent}/default`, 'Default', files, { detail: 'Default login', hint });
        }
        const [machine, id] = key.split('/') as [string, string];
        const label = labels.get(`${machine}/${agent}/${id}`);
        const from = machineNames.get(machine) ?? machine.slice(0, 12);
        return rollup(`${agent}/${key}`, label ?? id, files, {
          detail: label && label !== id ? `${id} · from ${from}` : `from ${from}`,
          hint,
          href: machine === join.machine ? '/settings/subscriptions' : undefined,
        });
      });
      rows.sort((a, b) =>
        a.title === 'Default' ? -1 : b.title === 'Default' ? 1 : a.title.localeCompare(b.title),
      );
      return { key: agent, title: CUSTODY_AGENT_LABELS[agent] ?? agent, rows };
    })
    .sort(byKey);
}

// ── Skills ──────────────────────────────────────────────────────────────────

function skillSections(entries: readonly CustodyEntry[]): FilesSection[] {
  // `skills/.seeded`, `skills/.bindings.json` and other top-level files are the
  // library's bookkeeping, not skills.
  const bySkill = bucket(entries, (e) => (segs(e).length >= 3 ? segs(e)[1]! : null));
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
  const byProvider = bucket(entries, (e) => (segs(e)[1] ?? '').replace(/\.json$/, ''));
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
  // A box's SSH key sits under its sandbox id and its served skills under its
  // box id: resolve both to the box so it is one row.
  const boxByKey = new Map<string, NonNullable<FilesJoin['boxes']>[number]>();
  for (const b of join.boxes ?? []) {
    boxByKey.set(b.id, b);
    if (b.sandboxId) boxByKey.set(b.sandboxId, b);
  }
  const byBox = bucket(entries, (e) => {
    const key = segs(e)[1];
    if (!key) return null;
    return boxByKey.get(key)?.id ?? key;
  });
  const rows = [...byBox.entries()]
    .map(([key, files]) => {
      const box = boxByKey.get(key);
      const kinds = [...new Set(files.map((f) => boxFileKind(segs(f).slice(2).join('/'))))];
      return rollup(key, key, files, {
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
 * overview is complete). An entry under an unknown scope is dropped. A group's
 * count and size are those of the files its rows show.
 */
export function buildFilesView(
  entries: readonly CustodyEntry[],
  join: FilesJoin = {},
): FilesGroup[] {
  const byScope = bucket(entries, (e) => {
    const scope = segs(e)[0] ?? '';
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
    const rows = sections.flatMap((s) => s.rows);
    return {
      id,
      ...GROUP_META[id],
      count: rows.reduce((n, r) => n + r.files, 0),
      size: rows.reduce((n, r) => n + r.size, 0),
      sections,
      link: id === 'skills' ? { href: '/settings/skills', label: 'Open Skills' } : undefined,
    };
  });
}
