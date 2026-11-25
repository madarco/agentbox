import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTar, treeHash, writeTar } from '@agentbox/sandbox-core';
import { executeHostReachAction } from '../src/daemon.js';
import { executePcSkillsAction, pcSkillsActionId } from '../src/pc-skills.js';
import { PendingPrompts, PromptSubscribers } from '../src/prompts.js';
import type { HostAction } from '../src/types.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function writeSkill(root: string, name: string, body = 'Do it.') {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
  );
  return dir;
}

describe('executePcSkillsAction', () => {
  it('inventory lists the skills with hashes and no file contents', async () => {
    const home = tmp('pcs-inv-');
    writeSkill(join(home, '.agents/skills'), 'alpha');
    const r = await executePcSkillsAction('pcskills.inventory', {}, { home });
    expect(r.exitCode).toBe(0);
    const inv = JSON.parse(r.stdout) as { skills: Record<string, unknown>[] };
    expect(inv.skills.map((s) => s.name)).toEqual(['alpha']);
    expect(inv.skills[0]).not.toHaveProperty('tarball');
    expect(r.stdout).not.toContain('Do it.');
  });

  it('export returns the tarball after a yes, and nothing after a no', async () => {
    const home = tmp('pcs-exp-');
    writeSkill(join(home, '.agents/skills'), 'alpha');
    const no = await executePcSkillsAction(
      'pcskills.export',
      { name: 'alpha' },
      { home, confirm: () => Promise.resolve(false) },
    );
    expect(no.exitCode).toBe(77);
    expect(no.stdout).toBe('');
    const yes = await executePcSkillsAction(
      'pcskills.export',
      { name: 'alpha' },
      { home, confirm: () => Promise.resolve(true) },
    );
    const got = JSON.parse(yes.stdout) as { version: string; tarball: string };
    expect(treeHash(readTar(Buffer.from(got.tarball, 'base64')))).toBe(got.version);
  });

  it('export refuses secret-scan findings unless allowed, without asking', async () => {
    const home = tmp('pcs-sec-');
    const dir = writeSkill(join(home, '.agents/skills'), 'leaky');
    writeFileSync(join(dir, 'conn.md'), 'use postgres://admin:Zq81vP0xLm@db.internal/app\n');
    let asked = 0;
    const confirm = () => {
      asked++;
      return Promise.resolve(true);
    };
    const r = await executePcSkillsAction('pcskills.export', { name: 'leaky' }, { home, confirm });
    expect(r.exitCode).toBe(65);
    expect(asked).toBe(0);
    const ok = await executePcSkillsAction(
      'pcskills.export',
      { name: 'leaky', allowFindings: true },
      { home, confirm },
    );
    expect(ok.exitCode).toBe(0);
  });

  it('install writes ~/.agents/skills/<name> after a yes', async () => {
    const home = tmp('pcs-ins-');
    const files = [
      {
        path: 'SKILL.md',
        mode: 0o644,
        data: Buffer.from('---\nname: beta\ndescription: d\n---\n'),
      },
    ];
    const params = {
      name: 'beta',
      version: treeHash(files),
      tarball: writeTar(files).toString('base64'),
    };
    const no = await executePcSkillsAction('pcskills.install', params, {
      home,
      confirm: () => Promise.resolve(false),
    });
    expect(no.exitCode).toBe(77);
    const r = await executePcSkillsAction('pcskills.install', params, {
      home,
      confirm: () => Promise.resolve(true),
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'installed' });
    expect(readFileSync(join(home, '.agents/skills/beta/SKILL.md'), 'utf8')).toMatch(/beta/);
  });

  it('an overridden scan names the findings in the confirm', async () => {
    const home = tmp('pcs-ovr-');
    const dir = writeSkill(join(home, '.agents/skills'), 'leaky');
    writeFileSync(join(dir, 'conn.md'), 'use postgres://admin:Zq81vP0xLm@db.internal/app\n');
    const asked: { message: string; detail?: string }[] = [];
    const r = await executePcSkillsAction(
      'pcskills.export',
      { name: 'leaky', allowFindings: true },
      {
        home,
        confirm: (p) => {
          asked.push(p);
          return Promise.resolve(true);
        },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(asked[0]!.message).toMatch(/despite its secret-scan findings/);
    expect(asked[0]!.detail).toMatch(/1 secret-scan finding\(s\) overridden \(/);
  });

  it('install asks only when it writes, and says replace only for an existing copy', async () => {
    const home = tmp('pcs-ask-');
    const files = [
      { path: 'SKILL.md', mode: 0o644, data: Buffer.from('---\nname: s\ndescription: d\n---\n') },
    ];
    const version = treeHash(files);
    const tarball = writeTar(files).toString('base64');
    const asked: string[] = [];
    const confirm = (p: { message: string }) => {
      asked.push(p.message);
      return Promise.resolve(true);
    };
    await executePcSkillsAction(
      'pcskills.install',
      { name: 's', version, tarball },
      { home, confirm },
    );
    expect(asked).toEqual([expect.stringMatching(/^Install skill s/) as unknown]);
    // Same version again: nothing to write, nothing to ask.
    await executePcSkillsAction(
      'pcskills.install',
      { name: 's', version, tarball },
      { home, confirm },
    );
    expect(asked).toHaveLength(1);
    // A different local copy without overwrite: skipped, not asked.
    writeFileSync(join(home, '.agents/skills/s/SKILL.md'), 'changed\n');
    const skip = await executePcSkillsAction(
      'pcskills.install',
      { name: 's', version, tarball },
      { home, confirm },
    );
    expect(JSON.parse(skip.stdout)).toMatchObject({ status: 'skipped' });
    expect(asked).toHaveLength(1);
    const rep = await executePcSkillsAction(
      'pcskills.install',
      { name: 's', version, tarball, overwrite: true },
      { home, confirm },
    );
    expect(JSON.parse(rep.stdout)).toMatchObject({ status: 'replaced' });
    expect(asked[1]).toMatch(/^Replace skill s/);
  });

  it('refuses a bad name', async () => {
    const r = await executePcSkillsAction('pcskills.export', { name: '../x' }, {});
    expect(r.exitCode).toBe(64);
  });
});

describe('executeHostReachAction for pcskills', () => {
  const deps = () => ({
    prompts: new PendingPrompts(),
    subscribers: new PromptSubscribers(),
    log: () => {},
    cache: { controlPlaneUrl: 'http://hub.invalid', adminToken: 't' },
  });
  const action = (over: Partial<HostAction> = {}): HostAction => ({
    id: 'a1',
    boxId: pcSkillsActionId('dev-1'),
    method: 'pcskills.inventory',
    params: {},
    createdAt: new Date().toISOString(),
    route: { role: 'origin' },
    ...over,
  });

  it('declines an unrouted skills action', async () => {
    const { route: _r, ...unrouted } = action();
    void _r;
    expect(await executeHostReachAction(unrouted, deps())).toMatchObject({
      decline: expect.stringMatching(/name the machine/) as unknown,
    });
  });

  it('answers a routed inventory for this machine', async () => {
    writeSkill(join(homedir(), '.agents/skills'), 'gamma');
    const r = await executeHostReachAction(action(), deps());
    expect(r).toMatchObject({ exitCode: 0 });
    expect(
      JSON.parse((r as { stdout: string }).stdout).skills.map((s: { name: string }) => s.name),
    ).toContain('gamma');
  });

  it('raises the export confirm on the hub and takes its answer', async () => {
    writeSkill(join(homedir(), '.agents/skills'), 'delta');
    const raised: string[] = [];
    const hub = {
      raise: (_id: string, p: { message: string }) => {
        raised.push(p.message);
        return Promise.resolve('hub-1');
      },
      status: () => Promise.resolve({ status: 'answered' as const, answer: 'y' as const }),
      cancel: () => Promise.resolve(),
    };
    const r = await executeHostReachAction(
      action({ method: 'pcskills.export', params: { name: 'delta' } }),
      { ...deps(), hub },
    );
    expect(raised).toEqual([expect.stringMatching(/Upload skill delta/) as unknown]);
    expect(r).toMatchObject({ exitCode: 0 });
  });
});
