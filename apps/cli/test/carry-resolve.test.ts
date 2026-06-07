import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CarryItem } from '@agentbox/ctl';
import { resolveCarry } from '../src/lib/carry-resolve.js';

let workspace: string;
let home: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'carry-resolve-'));
  home = await mkdtemp(join(tmpdir(), 'carry-home-'));
});

function item(src: string, dest?: string, extra: Partial<CarryItem> = {}): CarryItem {
  return { src, dest: dest ?? src, optional: false, ...extra };
}

describe('resolveCarry', () => {
  it('expands ~/ via injected homeDir, not the real $HOME', async () => {
    await writeFile(join(home, 'secret.env'), 'X=1');
    const res = await resolveCarry([item('~/secret.env')], {
      projectRoot: workspace,
      homeDir: home,
    });
    expect(res.errors).toEqual([]);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]?.absSrc).toBe(join(home, 'secret.env'));
    expect(res.entries[0]?.kind).toBe('file');
    expect(res.entries[0]?.bytes).toBe(3);
  });

  it('anchors ./relative to projectRoot, not process.cwd()', async () => {
    await writeFile(join(workspace, 'rel.txt'), 'hello');
    const res = await resolveCarry(
      [item('./rel.txt', '/workspace/rel.txt')],
      { projectRoot: workspace, homeDir: home },
    );
    expect(res.errors).toEqual([]);
    expect(res.entries[0]?.absSrc).toBe(join(workspace, 'rel.txt'));
  });

  it('missing src + optional:false → error', async () => {
    const res = await resolveCarry([item('/no/such/file')], {
      projectRoot: workspace,
      homeDir: home,
    });
    expect(res.entries).toHaveLength(0);
    expect(res.errors[0]).toMatch(/does not exist/);
  });

  it('missing src + optional:true → entry with kind=missing, no error', async () => {
    const res = await resolveCarry(
      [item('/no/such/file', '/dest', { optional: true })],
      { projectRoot: workspace, homeDir: home },
    );
    expect(res.errors).toEqual([]);
    expect(res.entries[0]?.kind).toBe('missing');
    expect(res.entries[0]?.optional).toBe(true);
  });

  it('rejects dest under /proc, /sys, /dev, and the exact /etc/passwd', async () => {
    await writeFile(join(workspace, 'a'), 'x');
    for (const bad of ['/proc/1/maps', '/sys/x', '/dev/null', '/etc/passwd', '/etc/shadow']) {
      const res = await resolveCarry(
        [item('./a', bad)],
        { projectRoot: workspace, homeDir: home },
      );
      expect(res.errors[0]).toMatch(/denylist/);
    }
  });

  it('rejects dest containing ..', async () => {
    await writeFile(join(workspace, 'a'), 'x');
    const res = await resolveCarry(
      [item('./a', '/home/vscode/../etc/passwd')],
      { projectRoot: workspace, homeDir: home },
    );
    expect(res.errors[0]).toMatch(/contains \.\./);
  });

  it('flags symlinks whose target is outside $HOME and projectRoot', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'carry-outside-'));
    await writeFile(join(outside, 'target'), 'x');
    await symlink(join(outside, 'target'), join(workspace, 'link'));
    const res = await resolveCarry(
      [item('./link', '/workspace/link')],
      { projectRoot: workspace, homeDir: home },
    );
    expect(res.errors).toEqual([]);
    expect(res.entries[0]?.symlinkInfo).toBe('outside-home');
  });

  it('safe symlinks (target inside projectRoot) are not flagged outside-home', async () => {
    await writeFile(join(workspace, 'target'), 'x');
    await symlink(join(workspace, 'target'), join(workspace, 'safe-link'));
    const res = await resolveCarry(
      [item('./safe-link', '/workspace/x')],
      { projectRoot: workspace, homeDir: home },
    );
    expect(res.entries[0]?.symlinkInfo).toBe('safe');
  });

  it('respects per-entry size cap (file too large)', async () => {
    await writeFile(join(workspace, 'big'), Buffer.alloc(100));
    const res = await resolveCarry(
      [item('./big', '/dst')],
      { projectRoot: workspace, homeDir: home, maxBytes: 50 },
    );
    expect(res.errors[0]).toMatch(/exceeds/);
  });

  it('respects per-entry size cap (dir too large)', async () => {
    await mkdir(join(workspace, 'd'));
    await writeFile(join(workspace, 'd', 'a'), Buffer.alloc(60));
    await writeFile(join(workspace, 'd', 'b'), Buffer.alloc(60));
    const res = await resolveCarry(
      [item('./d', '/dst')],
      { projectRoot: workspace, homeDir: home, maxBytes: 100 },
    );
    expect(res.errors[0]).toMatch(/exceeds/);
  });

  it('computes total bytes for a dir within cap', async () => {
    await mkdir(join(workspace, 'small'));
    await writeFile(join(workspace, 'small', 'a'), 'aa');
    await writeFile(join(workspace, 'small', 'b'), 'bbb');
    const res = await resolveCarry(
      [item('./small', '/dst')],
      { projectRoot: workspace, homeDir: home },
    );
    expect(res.entries[0]?.kind).toBe('dir');
    expect(res.entries[0]?.bytes).toBe(5);
  });

  it('maxBytes (box.cpMaxBytes) cap applies', async () => {
    await writeFile(join(workspace, 'big'), Buffer.alloc(200));
    const res = await resolveCarry(
      [item('./big', '/dst')],
      { projectRoot: workspace, homeDir: home, maxBytes: 100 },
    );
    expect(res.errors[0]).toMatch(/exceeds/);
  });

  it('preserves user-typed rawSrc / rawDest for the prompt', async () => {
    await writeFile(join(home, 'x.env'), 'X');
    const res = await resolveCarry(
      [item('~/x.env', '~/x.env')],
      { projectRoot: workspace, homeDir: home },
    );
    expect(res.entries[0]?.rawSrc).toBe('~/x.env');
    expect(res.entries[0]?.rawDest).toBe('~/x.env');
    expect(res.entries[0]?.absDest).toBe('~/x.env');
  });

  it('carries the mode through to the resolved entry', async () => {
    await writeFile(join(home, 'k'), 'x');
    const res = await resolveCarry(
      [item('~/k', '~/k', { mode: 0o600 })],
      { projectRoot: workspace, homeDir: home },
    );
    expect(res.entries[0]?.mode).toBe(0o600);
  });

  it('expands named rule-set refs + inline rules onto a file entry', async () => {
    await writeFile(join(home, 'e'), 'x');
    const res = await resolveCarry(
      [item('~/e', '/workspace/e', { replaceEnvs: true, rules: ['host'], replace: [{ from: 'a', to: 'b' }] })],
      {
        projectRoot: workspace,
        homeDir: home,
        replacements: { host: [{ from: 'optima', to: '{{AGENTBOX_BOX_NAME}}' }] },
      },
    );
    expect(res.errors).toEqual([]);
    expect(res.entries[0]?.replaceEnvs).toBe(true);
    expect(res.entries[0]?.replace).toEqual([
      { from: 'optima', to: '{{AGENTBOX_BOX_NAME}}' },
      { from: 'a', to: 'b' },
    ]);
  });

  it('rejects replace options on a directory entry', async () => {
    await mkdir(join(home, 'd'));
    await writeFile(join(home, 'd', 'f'), 'x');
    const res = await resolveCarry([item('~/d', '/workspace/d', { replaceEnvs: true })], {
      projectRoot: workspace,
      homeDir: home,
    });
    expect(res.entries).toHaveLength(0);
    expect(res.errors[0]).toMatch(/file-only/);
  });

  it('errors on an unknown rule-set ref', async () => {
    await writeFile(join(home, 'e'), 'x');
    const res = await resolveCarry([item('~/e', '/workspace/e', { rules: ['ghost'] })], {
      projectRoot: workspace,
      homeDir: home,
    });
    expect(res.entries).toHaveLength(0);
    expect(res.errors[0]).toMatch(/unknown replacements rule-set/);
  });
});
