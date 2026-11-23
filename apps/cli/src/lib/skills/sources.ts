/**
 * PC-side helpers for the skills library's sources and updates
 * (docs/hub-skills-plan.md, Phase 5): naming a marketplace by the name this PC
 * knows it by, finding the skills in a folder for `agentbox skills import`, and
 * rendering a version diff.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { HubApiSkillDiff } from '../../control-plane/hub-api-client.js';

export interface MarketplaceRef {
  marketplace: string;
  url: string;
  ref?: string;
}

/**
 * A marketplace argument: a git URL or `owner/repo` is used as is (any hub can
 * fetch it); a bare name is looked up in this PC's claude
 * `~/.claude/plugins/known_marketplaces.json`. Null when the name is unknown.
 */
export async function resolveMarketplace(
  arg: string,
  home: string,
): Promise<MarketplaceRef | null> {
  if (arg.includes('/') || arg.includes(':')) return { marketplace: arg, url: arg };
  let known: Record<string, { source?: Record<string, unknown> }>;
  try {
    known = JSON.parse(
      await readFile(join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'),
    ) as typeof known;
  } catch {
    return null;
  }
  const src = known[arg]?.source;
  if (!src) return null;
  const ref = typeof src.ref === 'string' ? { ref: src.ref } : {};
  if (src.source === 'github' && typeof src.repo === 'string') {
    return { marketplace: arg, url: src.repo, ...ref };
  }
  if ((src.source === 'git' || src.source === 'url') && typeof src.url === 'string') {
    return { marketplace: arg, url: src.url, ...ref };
  }
  return null;
}

async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'SKILL.md'))).isFile();
  } catch {
    return false;
  }
}

/** A folder that is a skill, or a folder of skills: `{name, dir}` per skill. */
export async function skillFoldersAt(path: string): Promise<{ name: string; dir: string }[]> {
  const dir = resolve(path);
  if (await hasSkillMd(dir)) return [{ name: basename(dir), dir }];
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  const out: { name: string; dir: string }[] = [];
  for (const n of names) {
    if (n.startsWith('.')) continue;
    if (await hasSkillMd(join(dir, n))) out.push({ name: n, dir: join(dir, n) });
  }
  return out;
}

const MAX_DIFF_LINES = 4000;

/** A minimal unified-style line diff (LCS); `null` when the files are too large to diff here. */
export function lineDiff(before: string, after: string): string[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES || a.length * b.length > 4_000_000) {
    return null;
  }
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ t: '-', s: a[i++]! });
    else ops.push({ t: '+', s: b[j++]! });
  }
  while (i < n) ops.push({ t: '-', s: a[i++]! });
  while (j < m) ops.push({ t: '+', s: b[j++]! });
  // Keep 2 lines of context around each change.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t === ' ') return;
    for (let d = Math.max(0, k - 2); d <= Math.min(ops.length - 1, k + 2); d++) keep[d] = true;
  });
  const out: string[] = [];
  let gap = false;
  ops.forEach((o, k) => {
    if (!keep[k]) {
      gap = true;
      return;
    }
    if (gap && out.length > 0) out.push('@@');
    gap = false;
    out.push(`${o.t}${o.s}`);
  });
  return out;
}

/** The diff as text, one section per file. */
export function renderSkillDiff(d: HubApiSkillDiff): string {
  if (d.files.length === 0) {
    return `${d.name}: ${d.from.slice(0, 12)} and ${d.to.slice(0, 12)} have the same files`;
  }
  const lines = [`${d.name}: ${d.from.slice(0, 12)} -> ${d.to.slice(0, 12)}`];
  for (const f of d.files) {
    lines.push('');
    if (f.modeOnly) {
      lines.push(`~ ${f.path} (mode changed)`);
      continue;
    }
    const mark = f.status === 'added' ? '+' : f.status === 'removed' ? '-' : '~';
    lines.push(`${mark} ${f.path}${f.binary ? ' (binary)' : ''}`);
    if (f.status === 'added' && f.after !== undefined) {
      lines.push(...f.after.split('\n').map((l) => `+${l}`));
    } else if (f.status === 'removed' && f.before !== undefined) {
      lines.push(...f.before.split('\n').map((l) => `-${l}`));
    } else if (f.before !== undefined && f.after !== undefined) {
      lines.push(...(lineDiff(f.before, f.after) ?? ['(too large to diff here)']));
    } else if (!f.binary) {
      lines.push('(too large to show)');
    }
  }
  return lines.join('\n');
}
