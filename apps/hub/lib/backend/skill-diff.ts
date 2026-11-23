// `GET /api/v1/skills/{name}/diff`: what an update changes, file by file, so a
// third-party (git, marketplace) update can be read before it is approved
// (docs/hub-skills-plan.md, Phase 5). Both versions are read back from custody
// with the same safe tar reader the PC and the box use.
import { readTar, type TarFile } from '@agentbox/sandbox-core';
import { openSkillTarball, readSkillMeta, SkillsError, type SkillsStore } from './skills';

/** Text bodies above this are reported as changed without their content. */
export const DIFF_MAX_TEXT_BYTES = 256 * 1024;

export interface SkillDiffFile {
  path: string;
  status: 'added' | 'removed' | 'modified';
  /** Mode change only (0644 ↔ 0755), content identical. */
  modeOnly?: boolean;
  binary?: boolean;
  /** Omitted for binary files and text over {@link DIFF_MAX_TEXT_BYTES}. */
  before?: string;
  after?: string;
}

export interface SkillDiff {
  name: string;
  from: string;
  to: string;
  files: SkillDiffFile[];
}

async function readVersion(store: SkillsStore, name: string, version: string): Promise<TarFile[]> {
  const t = await openSkillTarball(store, name, version);
  const chunks: Buffer[] = [];
  for await (const c of t.data as AsyncIterable<Buffer | string>) {
    chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  }
  return readTar(Buffer.concat(chunks));
}

function isBinary(b: Buffer): boolean {
  return b.subarray(0, 8000).includes(0);
}

function text(b: Buffer | undefined): string | undefined {
  if (!b || b.length > DIFF_MAX_TEXT_BYTES || isBinary(b)) return undefined;
  return b.toString('utf8');
}

/** Pure: compare two file sets. */
export function diffFileSets(
  before: readonly TarFile[],
  after: readonly TarFile[],
): SkillDiffFile[] {
  const a = new Map(before.map((f) => [f.path, f]));
  const b = new Map(after.map((f) => [f.path, f]));
  const out: SkillDiffFile[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path);
    const y = b.get(path);
    const bin = (x && isBinary(x.data)) || (y && isBinary(y.data)) ? { binary: true } : {};
    if (x && !y) {
      const before = text(x.data);
      out.push({ path, status: 'removed', ...bin, ...(before !== undefined ? { before } : {}) });
    } else if (!x && y) {
      const after = text(y.data);
      out.push({ path, status: 'added', ...bin, ...(after !== undefined ? { after } : {}) });
    } else if (x && y) {
      const same = x.data.equals(y.data);
      if (same && x.mode === y.mode) continue;
      if (same) {
        out.push({ path, status: 'modified', modeOnly: true });
        continue;
      }
      const before = text(x.data);
      const after = text(y.data);
      out.push({
        path,
        status: 'modified',
        ...bin,
        ...(before !== undefined && after !== undefined ? { before, after } : {}),
      });
    }
  }
  return out;
}

/**
 * Diff two stored versions. Defaults: `to` = the pending version, else current;
 * `from` = current, or the version before current when `to` is current.
 */
export async function diffSkillVersions(
  store: SkillsStore,
  name: string,
  opts: { from?: string; to?: string } = {},
): Promise<SkillDiff> {
  const meta = await readSkillMeta(store, name);
  if (!meta) throw new SkillsError('not_found', `no skill '${name}' on this hub`);
  const to = opts.to ?? meta.pending ?? meta.current;
  let from = opts.from;
  if (!from) {
    if (to !== meta.current) from = meta.current;
    else from = meta.versions.find((v) => v.sha256 !== meta.current)?.sha256 ?? meta.current;
  }
  const [x, y] = await Promise.all([readVersion(store, name, from), readVersion(store, name, to)]);
  return { name, from, to, files: diffFileSets(x, y) };
}
