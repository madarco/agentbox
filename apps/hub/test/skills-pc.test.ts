import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { executePcSkillsAction, isPcSkillsMethod } from '@agentbox/relay';
import { treeHash, writeTar, type AgentSkillDirs } from '@agentbox/sandbox-core';
import { importSkill, readSkillMeta } from '../lib/backend/skills';
import { createPcSkillsBackend, type PcReach } from '../lib/backend/skills-pc';
import {
  rowMoves,
  statusLabel,
  syncPlan,
} from '../app/(dashboard)/settings/skills/components/pc-sync';
import type { CompareRow } from '../app/(dashboard)/settings/skills/components/api';
import { memStore } from './_skills-mem-store';

const AGENTS: AgentSkillDirs[] = [
  { id: 'claude', dirs: ['.claude/skills'] },
  { id: 'codex', dirs: ['.codex/skills', '.agents/skills'] },
];
const md = (name: string, body = 'Do it.') =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`;

function writeSkill(root: string, name: string, body?: string) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), md(name, body));
}

async function seedHub(
  store: ReturnType<typeof memStore>,
  name: string,
  body?: string,
  path?: string,
) {
  const files = [{ path: 'SKILL.md', mode: 0o644, data: Buffer.from(md(name, body)) }];
  await importSkill(store, {
    name,
    meta: {
      sha256: treeHash(files),
      description: `${name} skill`,
      size: files[0]!.data.length,
      files: 1,
      source: { host: 'mac', ...(path ? { path } : {}) },
    },
    body: Readable.from([writeTar(files)]),
  });
}

function setup(opts: { deviceOnline?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hub-pcs-'));
  const store = memStore();
  const changed: string[] = [];
  const runLocal = async (method: string, params: unknown): Promise<PcReach> => {
    if (!isPcSkillsMethod(method)) throw new Error(method);
    return { kind: 'result', ...(await executePcSkillsAction(method, params, { home })) };
  };
  const deviceCalls: string[] = [];
  const backend = createPcSkillsBackend({
    store: () => store,
    self: () => ({ id: 'self-id', label: 'devbox' }),
    devices: () => [
      { id: 'self-id', label: 'devbox' },
      { id: 'mac-id', label: 'MacBook' },
    ],
    present: () => (opts.deviceOnline ? ['mac-id'] : []),
    runSelf: runLocal,
    runDevice: (id, _label, method, params) => {
      deviceCalls.push(`${id}:${method}`);
      return runLocal(method, params);
    },
    skillsChanged: (n) => changed.push(...n),
    agentDirs: () => AGENTS,
  });
  return { home, store, backend, changed, deviceCalls };
}

describe('hub <-> PC skills backend', () => {
  it('lists the hub machine first and enrolled devices once, with presence', async () => {
    const { backend } = setup({ deviceOnline: true });
    const r = await backend.skillMachines();
    expect(r.machines).toEqual([
      { id: 'self-id', label: 'devbox', self: true, online: true },
      { id: 'mac-id', label: 'MacBook', self: false, online: true },
    ]);
    expect(r.defaultId).toBe('self-id');
  });

  it('compares: only on PC, only on hub, differs, same; agents from the dirs', async () => {
    const { home, store, backend } = setup();
    writeSkill(join(home, '.agents/skills'), 'pc-only');
    writeSkill(join(home, '.agents/skills'), 'both', 'local edit');
    writeSkill(join(home, '.claude/skills'), 'same');
    await seedHub(store, 'hub-only', undefined, '/Users/m/.claude/skills/hub-only');
    await seedHub(store, 'both', 'hub edit');
    await seedHub(store, 'same');
    const c = await backend.compareMachineSkills('self-id');
    const by = Object.fromEntries(c.rows.map((r) => [r.name, r]));
    // A PC row's agents come from the PC's own registry (every agent reading ~/.agents).
    expect(by['pc-only']!.status).toBe('local-only');
    expect(by['pc-only']!.agents).toContain('codex');
    expect(by['pc-only']!.agents).not.toContain('claude');
    expect(by['hub-only']).toMatchObject({ status: 'hub-only', agents: ['claude'] });
    expect(by['both']!.status).toBe('differs');
    expect(by['same']!.status).toBe('same');
    expect(by['same']!.agents).toContain('claude');
    expect(c.outOfSync).toBe(3);
  });

  it('pull imports the PC copy with its source, and fans out', async () => {
    const { home, store, backend, changed } = setup();
    writeSkill(join(home, '.agents/skills'), 'pc-only');
    const [r] = await backend.pullSkills('self-id', ['pc-only']);
    expect(r).toMatchObject({ name: 'pc-only', status: 'imported' });
    const meta = await readSkillMeta(store, 'pc-only');
    expect(meta?.versions[0]?.source).toMatchObject({
      host: 'devbox',
      machineId: 'self-id',
      path: join(home, '.agents/skills/pc-only'),
    });
    expect(changed).toEqual(['pc-only']);
    expect((await backend.compareMachineSkills('self-id')).rows[0]!.status).toBe('same');
  });

  it('send lands a hub skill on disk; a differing copy needs overwrite', async () => {
    const { home, store, backend } = setup();
    await seedHub(store, 'hub-only');
    const [r] = await backend.sendSkills('self-id', ['hub-only']);
    expect(r).toMatchObject({ status: 'installed' });
    expect(readFileSync(join(home, '.agents/skills/hub-only/SKILL.md'), 'utf8')).toMatch(
      /hub-only/,
    );

    writeSkill(join(home, '.agents/skills'), 'both', 'local');
    await seedHub(store, 'both', 'hub');
    expect((await backend.sendSkills('self-id', ['both']))[0]).toMatchObject({ status: 'skipped' });
    expect((await backend.sendSkills('self-id', ['both'], { overwrite: true }))[0]).toMatchObject({
      status: 'replaced',
    });
  });

  it('an offline device lists hub rows as unknown and never gets the action', async () => {
    const { store, backend, deviceCalls } = setup({ deviceOnline: false });
    await seedHub(store, 'x');
    const c = await backend.compareMachineSkills('mac-id');
    expect(c.machine.online).toBe(false);
    expect(c.error).toMatch(/MacBook is offline/);
    expect(c.rows).toEqual([expect.objectContaining({ name: 'x', status: 'unknown' })]);
    expect((await backend.sendSkills('mac-id', ['x']))[0]).toMatchObject({ status: 'failed' });
    expect(deviceCalls).toEqual([]);
  });

  it('routes an online device through runDevice', async () => {
    const { backend, deviceCalls } = setup({ deviceOnline: true });
    await backend.compareMachineSkills('mac-id');
    expect(deviceCalls).toEqual(['mac-id:pcskills.inventory']);
  });

  it('refuses an unknown machine', async () => {
    const { backend } = setup();
    await expect(backend.compareMachineSkills('nope')).rejects.toThrow(/no machine/);
  });
});

describe('skills page helpers', () => {
  const row = (over: Partial<CompareRow>): CompareRow => ({
    name: 'x',
    description: '',
    status: 'same',
    agents: [],
    ...over,
  });
  it('labels each status for the machine', () => {
    expect(statusLabel(row({}), 'MacBook', true)).toBe('On Hub and MacBook');
    expect(statusLabel(row({ status: 'local-only' }), 'MacBook', true)).toBe('Only on MacBook');
    expect(statusLabel(row({ status: 'hub-only' }), 'MacBook', true)).toBe('Only on Hub');
    expect(statusLabel(row({ status: 'differs', newer: 'local' }), 'MacBook', true)).toBe(
      'Differs · newer on MacBook',
    );
    expect(statusLabel(row({ status: 'unknown' }), 'MacBook', false)).toBe('MacBook offline');
  });
  it('offers the moves that fix the row', () => {
    expect(rowMoves(row({ status: 'local-only' }))).toEqual(['pull']);
    expect(rowMoves(row({ status: 'hub-only' }))).toEqual(['send']);
    expect(rowMoves(row({ status: 'differs' }))).toEqual(['pull', 'send']);
    expect(rowMoves(row({}))).toEqual([]);
  });
  it('sync all moves each row from the side that changed last, skipping blocked uploads', () => {
    const pc = (problems: string[] = [], findings = 0) => ({
      treeSha: 'a',
      dirs: [],
      path: '/p',
      size: 1,
      files: 1,
      problems,
      findings: Array.from({ length: findings }, () => ({ rule: 'r', path: 'f', line: 1 })),
    });
    const plan = syncPlan([
      row({ name: 'a', status: 'local-only', pc: pc() }),
      row({ name: 'b', status: 'hub-only' }),
      row({ name: 'c', status: 'differs', newer: 'local', pc: pc() }),
      row({ name: 'd', status: 'differs', newer: 'hub', pc: pc() }),
      row({ name: 'e', status: 'local-only', pc: pc(['bad name']) }),
      row({ name: 'f', status: 'local-only', pc: pc([], 2) }),
      row({ name: 'g', status: 'same' }),
    ]);
    expect(plan.pull).toEqual(['a', 'c']);
    expect(plan.send).toEqual(['b', 'd']);
    expect(plan.overwrite).toEqual(['d']);
    expect(plan.skipped.map((s) => s.name)).toEqual(['e', 'f']);
  });
});
