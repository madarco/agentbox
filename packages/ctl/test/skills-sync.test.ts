import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { treeHash, writeTar } from '@agentbox/sandbox-core';
import { syncBoxSkills, type SkillsRpc } from '../src/skills-sync.js';

function skill(name: string, body: string) {
  const files = [
    {
      path: 'SKILL.md',
      mode: 0o644,
      data: Buffer.from(`---\nname: ${name}\ndescription: d\n---\n${body}\n`),
    },
    { path: 'scripts/run.sh', mode: 0o755, data: Buffer.from('echo hi\n') },
  ];
  return { name, version: treeHash(files), tar: writeTar(files) };
}

/** A fake host: serves the given set, chunking blobs at `chunk` bytes. */
function host(set: ReturnType<typeof skill>[], opts: { library?: boolean; chunk?: number } = {}) {
  const calls: string[] = [];
  const rpc: SkillsRpc = (method, params) => {
    calls.push(method);
    if (method === 'skills.get') {
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          library: opts.library ?? true,
          skills: set.map((s) => ({ name: s.name, version: s.version, bytes: s.tar.length })),
        }),
        stderr: '',
      });
    }
    const p = params as { name: string; version: string; offset: number };
    const s = set.find((x) => x.name === p.name && x.version === p.version);
    if (!s) return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'not in set' });
    const chunk = opts.chunk ?? 1 << 20;
    const data = s.tar.subarray(p.offset, p.offset + chunk);
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        data: data.toString('base64'),
        size: s.tar.length,
        eof: p.offset + data.length >= s.tar.length,
      }),
      stderr: '',
    });
  };
  return { rpc, calls };
}

function dirs() {
  const base = mkdtempSync(join(tmpdir(), 'ctl-skills-'));
  return {
    root: join(base, 'library'),
    linkDir: join(base, 'etc', 'claude-code', '.claude', 'skills'),
  };
}

describe('syncBoxSkills', () => {
  it('does nothing when the host has no library', async () => {
    const d = dirs();
    const h = host([], { library: false });
    const r = await syncBoxSkills({ ...d, linkDirs: [d.linkDir], log: () => {}, rpc: h.rpc });
    expect(r.library).toBe(false);
    expect(existsSync(d.root)).toBe(false);
  });

  it('installs, links, keeps, updates and removes, by the manifest', async () => {
    const d = dirs();
    const a = skill('alpha', 'one');
    const b = skill('beta', 'two');
    let r = await syncBoxSkills({
      ...d,
      linkDirs: [d.linkDir],
      log: () => {},
      rpc: host([a, b], { chunk: 64 }).rpc,
    });
    expect(r.installed.sort()).toEqual(['alpha', 'beta']);
    expect(readFileSync(join(d.root, 'alpha', 'SKILL.md'), 'utf8')).toContain('one');
    expect(lstatSync(join(d.root, 'alpha', 'scripts', 'run.sh')).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(d.linkDir, 'alpha'))).toBe(join(d.root, 'alpha'));

    // A user's own skill in the injection dir is never touched.
    mkdirSync(join(d.linkDir, 'mine'));
    writeFileSync(join(d.linkDir, 'mine', 'SKILL.md'), 'user skill');

    // Same versions: nothing downloaded again.
    const again = host([a, b]);
    r = await syncBoxSkills({ ...d, linkDirs: [d.linkDir], log: () => {}, rpc: again.rpc });
    expect(r.kept.sort()).toEqual(['alpha', 'beta']);
    expect(again.calls).toEqual(['skills.get']);

    // alpha updated, beta dropped from the set.
    const a2 = skill('alpha', 'one, revised');
    r = await syncBoxSkills({ ...d, linkDirs: [d.linkDir], log: () => {}, rpc: host([a2]).rpc });
    expect(r.installed).toEqual(['alpha']);
    expect(r.removed).toEqual(['beta']);
    expect(readFileSync(join(d.root, 'alpha', 'SKILL.md'), 'utf8')).toContain('revised');
    expect(existsSync(join(d.root, 'beta'))).toBe(false);
    expect(existsSync(join(d.linkDir, 'beta'))).toBe(false);
    expect(readFileSync(join(d.linkDir, 'mine', 'SKILL.md'), 'utf8')).toBe('user skill');
  });

  it('refuses a tarball whose files do not hash to the named version, keeping the old copy', async () => {
    const d = dirs();
    const a = skill('alpha', 'one');
    await syncBoxSkills({ ...d, linkDirs: [d.linkDir], log: () => {}, rpc: host([a]).rpc });
    const forged = { ...skill('alpha', 'evil'), version: 'f'.repeat(64) };
    const r = await syncBoxSkills({
      ...d,
      linkDirs: [d.linkDir],
      log: () => {},
      rpc: host([forged]).rpc,
    });
    expect(r.failed[0]?.reason).toMatch(/hash to/);
    expect(readFileSync(join(d.root, 'alpha', 'SKILL.md'), 'utf8')).toContain('one');
  });

  it('a truncated blob fails only that skill; the others install', async () => {
    const d = dirs();
    const a = skill('alpha', 'one');
    const b = skill('beta', 'two');
    const cut = { ...b, tar: b.tar.subarray(0, Math.floor(b.tar.length / 2)) };
    const r = await syncBoxSkills({
      ...d,
      linkDirs: [d.linkDir],
      log: () => {},
      rpc: host([a, cut], { chunk: 16 }).rpc,
    });
    expect(r.installed).toEqual(['alpha']);
    expect(r.failed.map((f) => f.name)).toEqual(['beta']);
    expect(existsSync(join(d.root, 'beta'))).toBe(false);
  });

  it('never replaces an entry in an injection dir that ctl did not create', async () => {
    const d = dirs();
    mkdirSync(join(d.linkDir, 'alpha'), { recursive: true });
    writeFileSync(join(d.linkDir, 'alpha', 'SKILL.md'), 'theirs');
    const logs: string[] = [];
    await syncBoxSkills({
      ...d,
      linkDirs: [d.linkDir],
      log: (m) => logs.push(m),
      rpc: host([skill('alpha', 'one')]).rpc,
    });
    expect(readFileSync(join(d.linkDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('theirs');
    expect(logs.join('\n')).toMatch(/is not ours/);
  });
});
