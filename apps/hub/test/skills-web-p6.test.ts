import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { treeHash, writeTar, type TarFile } from '@agentbox/sandbox-core';
import { approveSkillUpdate, importSkill, readSkillMeta } from '../lib/backend/skills';
import { readSkillMd, saveSkillMd } from '../lib/backend/skill-editor';
import { diffSkillVersions } from '../lib/backend/skill-diff';
import { boxSkillsRecordPath, skillsStatusOverview } from '../lib/backend/skill-boxes';
import { hunks, lineDiff } from '../app/(dashboard)/settings/skills/components/line-diff';
import { memStore } from './_skills-mem-store';

const md = (name: string, body = 'Do the thing.') =>
  `---\nname: ${name}\ndescription: A skill.\n---\n\n${body}\n`;

async function seed(
  store: ReturnType<typeof memStore>,
  name: string,
  files: TarFile[],
  origin?: { kind: 'git'; url: string; commit: string },
) {
  return importSkill(store, {
    name,
    meta: {
      sha256: treeHash(files),
      description: 'A skill.',
      size: files.reduce((n, f) => n + f.data.length, 0),
      files: files.length,
      source: { host: 'mac' },
    },
    body: Readable.from([writeTar(files)]),
    ...(origin ? { origin } : {}),
  });
}

const file = (path: string, text: string, mode = 0o644): TarFile => ({
  path,
  mode,
  data: Buffer.from(text),
});

describe('SKILL.md editor', () => {
  it('creates a new skill with SKILL.md only', async () => {
    const store = memStore();
    const r = await saveSkillMd(store, 'fresh', { content: md('fresh') });
    expect(r.currentChanged).toBe(true);
    expect(r.findings).toEqual([]);
    const read = await readSkillMd(store, 'fresh');
    expect(read.content).toBe(md('fresh'));
    expect(read.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect((await readSkillMeta(store, 'fresh'))?.origin).toEqual({ kind: 'upload' });
  });

  it('keeps the other files, swaps SKILL.md, and turns a git skill into an upload', async () => {
    const store = memStore();
    const first = await seed(
      store,
      'tool',
      [file('SKILL.md', md('tool')), file('run.sh', '#!/bin/sh\necho hi\n', 0o755)],
      { kind: 'git', url: 'https://example.com/r.git', commit: 'c'.repeat(40) },
    );
    const r = await saveSkillMd(store, 'tool', {
      content: md('tool', 'Do it differently.'),
      base: first.version,
    });
    expect(r.held).toBe(false);
    expect(r.version).not.toBe(first.version);
    const read = await readSkillMd(store, 'tool');
    expect(read.content).toContain('Do it differently.');
    expect(read.files.find((f) => f.path === 'run.sh')?.mode).toBe(0o755);
    const meta = await readSkillMeta(store, 'tool');
    expect(meta?.current).toBe(r.version);
    expect(meta?.origin?.kind).toBe('upload');
  });

  it('refuses a stale base, a mismatched name, a missing description and a duplicate create', async () => {
    const store = memStore();
    const first = await saveSkillMd(store, 'x', { content: md('x') });
    await saveSkillMd(store, 'x', { content: md('x', 'v2'), base: first.version });
    await expect(
      saveSkillMd(store, 'x', { content: md('x', 'v3'), base: first.version }),
    ).rejects.toThrow(/changed since the editor opened/);
    await expect(saveSkillMd(store, 'y', { content: md('z') })).rejects.toThrow(/names itself/);
    await expect(saveSkillMd(store, 'y', { content: '---\nname: y\n---\nbody\n' })).rejects.toThrow(
      /description/,
    );
    await expect(saveSkillMd(store, 'x', { content: md('x') })).rejects.toThrow(/already exists/);
    await expect(saveSkillMd(store, 'agentbox-x', { content: md('agentbox-x') })).rejects.toThrow(
      /reserved/,
    );
  });

  it('blocks a secret-scan hit unless allowFindings', async () => {
    const store = memStore();
    const key = 'AKIA' + 'Q7XZ3M5N2P4R6T8V';
    const content = md('k', `aws_access_key_id = ${key}`);
    await expect(saveSkillMd(store, 'k', { content })).rejects.toThrow(/secret scan/);
    const r = await saveSkillMd(store, 'k', { content, allowFindings: true });
    expect(r.findings.length).toBeGreaterThan(0);
  });
});

describe('review pinning and concurrency', () => {
  it('refuses to approve a pending version other than the reviewed one', async () => {
    const store = memStore();
    const origin = {
      kind: 'git' as const,
      url: 'https://example.com/r.git',
      commit: 'c'.repeat(40),
    };
    await seed(store, 'p', [file('SKILL.md', md('p'))], origin);
    const b = await seed(store, 'p', [file('SKILL.md', md('p', 'b'))], origin);
    const c = await seed(store, 'p', [file('SKILL.md', md('p', 'c'))], origin);
    expect(c.held).toBe(true);
    await expect(
      approveSkillUpdate(store, 'p', b.version, new Date(), { onlyPending: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const ok = await approveSkillUpdate(store, 'p', c.version, new Date(), { onlyPending: true });
    expect(ok.to).toBe(c.version);
  });

  it('lets only one of two concurrent saves from the same base land', async () => {
    const store = memStore();
    const first = await saveSkillMd(store, 'race', { content: md('race') });
    const results = await Promise.allSettled([
      saveSkillMd(store, 'race', { content: md('race', 'one'), base: first.version }),
      saveSkillMd(store, 'race', { content: md('race', 'two'), base: first.version }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'conflict' });
  });
});

describe('diff findings', () => {
  it("reports the hub's scan of the target version", async () => {
    const store = memStore();
    const a = await seed(store, 'd', [file('SKILL.md', md('d'))]);
    const b = await seed(store, 'd', [file('SKILL.md', md('d')), file('.env', 'X=1\n')]);
    const diff = await diffSkillVersions(store, 'd', { from: a.version, to: b.version });
    expect(diff.files.map((f) => f.path)).toEqual(['.env']);
    expect(diff.findings.map((f) => f.rule)).toContain('secret-file');
  });
});

describe('skill status overview', () => {
  it('lists pending updates and the live boxes behind', async () => {
    const store = memStore();
    const origin = {
      kind: 'git' as const,
      url: 'https://example.com/r.git',
      commit: 'c'.repeat(40),
    };
    const v1 = await seed(store, 'g', [file('SKILL.md', md('g'))], origin);
    const v2 = await seed(store, 'g', [file('SKILL.md', md('g', 'new'))], origin);
    expect(v2.held).toBe(true);
    const u = await seed(store, 'u', [file('SKILL.md', md('u'))]);
    await seed(store, 'u', [file('SKILL.md', md('u', 'v2'))]);
    const rec = (skills: Record<string, string>) =>
      Buffer.from(JSON.stringify({ at: '2026-11-23T00:00:00Z', skills }));
    await store.put(boxSkillsRecordPath('b1'), rec({ g: v1.version, u: u.version }));
    await store.put(boxSkillsRecordPath('gone'), rec({ u: u.version }));
    const out = await skillsStatusOverview({ store, boxIds: () => Promise.resolve(['b1', 'b2']) });
    expect(out.pending).toEqual([{ name: 'g', version: v2.version }]);
    // `g` is pending, not current, so b1 is behind only on `u`; `gone` isn't live.
    expect(out.boxes).toEqual([{ boxId: 'b1', behind: ['u'] }]);
  });
});

describe('lineDiff', () => {
  it('diffs an added file without a phantom empty line', () => {
    expect(lineDiff('', 'foo')).toEqual([{ op: '+', text: 'foo' }]);
    expect(lineDiff('foo', '')).toEqual([{ op: '-', text: 'foo' }]);
  });

  it('marks changed lines and folds unchanged ones', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${String(i)}`).join('\n');
    const after = before.replace('l10', 'L10');
    const d = lineDiff(before, after);
    expect(d.filter((l) => l.op === '-')).toEqual([{ op: '-', text: 'l10' }]);
    expect(d.filter((l) => l.op === '+')).toEqual([{ op: '+', text: 'L10' }]);
    const h = hunks(d, 2);
    expect(h[0]).toEqual({ op: '…', skipped: 8 });
    expect(h.at(-1)).toEqual({ op: '…', skipped: 7 });
  });
});
