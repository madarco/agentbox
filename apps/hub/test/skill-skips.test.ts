// Skipped skills ("never sync"): the comparison, pull, send, the library
// listing the first seed reads, box status, and the web helpers.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { executePcSkillsAction, isPcSkillsMethod } from '@agentbox/relay';
import { treeHash, writeTar, type AgentSkillDirs } from '@agentbox/sandbox-core';
import { importSkill, listSkills, SkillsError } from '../lib/backend/skills';
import { createPcSkillsBackend, type PcReach } from '../lib/backend/skills-pc';
import { assertNotSkipped, listSkippedSkills, setSkillSkipped } from '../lib/backend/skill-skips';
import { boxSkillsStatus, syncSkillBoxes } from '../lib/backend/skill-boxes';
import { previewSkillSet } from '../lib/backend/skill-bindings';
import { skillsView } from '../lib/backend/mcp-skills';
import {
  rowMoves,
  statusLabel,
  syncPlan,
} from '../app/(dashboard)/settings/skills/components/pc-sync';
import type { CompareRow } from '../app/(dashboard)/settings/skills/components/api';
import { memStore } from './_skills-mem-store';

const AGENTS: AgentSkillDirs[] = [{ id: 'codex', dirs: ['.agents/skills'] }];
const md = (name: string, body = 'Do it.') =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`;

function writeSkill(root: string, name: string, body?: string) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), md(name, body));
}

async function seedHub(store: ReturnType<typeof memStore>, name: string, body?: string) {
  const files = [{ path: 'SKILL.md', mode: 0o644, data: Buffer.from(md(name, body)) }];
  await importSkill(store, {
    name,
    meta: {
      sha256: treeHash(files),
      description: `${name} skill`,
      size: files[0]!.data.length,
      files: 1,
      source: { host: 'mac' },
    },
    body: Readable.from([writeTar(files)]),
  });
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'hub-skip-'));
  const store = memStore();
  const calls: string[] = [];
  const backend = createPcSkillsBackend({
    store: () => store,
    self: () => ({ id: 'self-id', label: 'devbox' }),
    devices: () => [],
    present: () => [],
    runSelf: async (method: string, params: unknown): Promise<PcReach> => {
      if (!isPcSkillsMethod(method)) throw new Error(method);
      calls.push(method);
      return { kind: 'result', ...(await executePcSkillsAction(method, params, { home })) };
    },
    skillsChanged: () => undefined,
    agentDirs: () => AGENTS,
  });
  return { home, store, backend, calls };
}

describe('skill skips store', () => {
  it('skips by name (even one the library lacks), lists it, and unskips', async () => {
    const store = memStore();
    const a = await setSkillSkipped(store, 'pc-only', true);
    expect(a.changed).toBe(true);
    expect(a.skipped.map((s) => s.name)).toEqual(['pc-only']);
    expect((await setSkillSkipped(store, 'pc-only', true)).changed).toBe(false);
    expect((await listSkills(store)).skipped).toEqual(['pc-only']);
    const b = await setSkillSkipped(store, 'pc-only', false);
    expect(b).toEqual({ changed: true, skipped: [] });
    expect(await listSkippedSkills(store)).toEqual([]);
  });

  it('refuses an invalid name and never touches the library', async () => {
    const store = memStore();
    await seedHub(store, 'kept');
    await expect(setSkillSkipped(store, 'Bad Name', true)).rejects.toThrow(SkillsError);
    await setSkillSkipped(store, 'kept', true);
    expect((await listSkills(store)).skills.map((s) => s.name)).toEqual(['kept']);
  });

  it('assertNotSkipped answers a 409 conflict naming the skill', async () => {
    const store = memStore();
    await setSkillSkipped(store, 'x', true);
    await expect(assertNotSkipped(store, ['y'])).resolves.toBeUndefined();
    const err = await assertNotSkipped(store, ['y', 'x']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillsError);
    expect((err as SkillsError).code).toBe('conflict');
    expect((err as SkillsError).message).toMatch(/'x' is skipped/);
  });
});

describe('skipped skills against a PC', () => {
  it('compare marks them skipped on either side and leaves them out of sync counts', async () => {
    const { home, store, backend } = setup();
    writeSkill(join(home, '.agents/skills'), 'pc-only');
    writeSkill(join(home, '.agents/skills'), 'both', 'local edit');
    await seedHub(store, 'both', 'hub edit');
    await seedHub(store, 'hub-only');
    for (const n of ['pc-only', 'both', 'hub-only']) await setSkillSkipped(store, n, true);
    const c = await backend.compareMachineSkills('self-id');
    expect(c.rows.map((r) => [r.name, r.status])).toEqual([
      ['both', 'skipped'],
      ['hub-only', 'skipped'],
      ['pc-only', 'skipped'],
    ]);
    expect(c.outOfSync).toBe(0);
    expect(c.skipped).toEqual(['both', 'hub-only', 'pc-only']);
    await setSkillSkipped(store, 'pc-only', false);
    const again = await backend.compareMachineSkills('self-id');
    expect(again.rows.find((r) => r.name === 'pc-only')!.status).toBe('local-only');
    expect(again.outOfSync).toBe(1);
  });

  it('pull and send refuse a skipped skill with a conflict, before asking the PC', async () => {
    const { home, store, backend, calls } = setup();
    writeSkill(join(home, '.agents/skills'), 'pc-only');
    await seedHub(store, 'hub-only');
    await setSkillSkipped(store, 'pc-only', true);
    await setSkillSkipped(store, 'hub-only', true);
    await expect(backend.pullSkills('self-id', ['pc-only'])).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(backend.sendSkills('self-id', ['hub-only'])).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(calls).toEqual([]);
    expect((await listSkills(store)).skills.map((s) => s.name)).toEqual(['hub-only']);
  });
});

describe('skipped skills and boxes', () => {
  it('a box holding a skipped skill is behind, so the fan-out syncs it away', async () => {
    const store = memStore();
    await seedHub(store, 'one');
    const current = (await listSkills(store)).skills[0]!.current;
    await store.put(
      'boxes/b1/skills.json',
      Buffer.from(JSON.stringify({ at: 'x', skills: { one: current } })),
    );
    expect((await boxSkillsStatus(store, 'b1')).skills[0]!.behind).toBe(false);
    await setSkillSkipped(store, 'one', true);
    expect((await boxSkillsStatus(store, 'b1')).skills[0]!.behind).toBe(true);
  });

  it('after an unskip, every box that pulled from the hub syncs (not only behind ones)', async () => {
    const store = memStore();
    await seedHub(store, 'one');
    await store.put('boxes/b1/skills.json', Buffer.from(JSON.stringify({ at: 'x', skills: {} })));
    const synced: string[] = [];
    const deps = {
      store,
      boxIds: () => Promise.resolve(['b1', 'never-pulled']),
      probeState: () => Promise.resolve('running'),
      exec: (id: string) => {
        synced.push(id);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      },
      log: () => undefined,
    };
    expect(await syncSkillBoxes(deps, { names: ['one'] })).toEqual([]);
    const r = await syncSkillBoxes(deps, { recorded: true });
    expect(r.map((o) => [o.boxId, o.status])).toEqual([['b1', 'synced']]);
    expect(synced).toEqual(['b1']);
  });

  it('the create preview and a box MCP view leave a skipped skill out', async () => {
    const store = memStore();
    await seedHub(store, 'one');
    await seedHub(store, 'two');
    await setSkillSkipped(store, 'one', true);
    expect((await previewSkillSet(store, {})).skills.map((s) => s.name)).toEqual(['two']);
    const view = await skillsView(store, {
      kind: 'box',
      boxId: 'b1',
      skills: { boxId: 'b1' },
    } as unknown as Parameters<typeof skillsView>[1]);
    expect(view.visible).toEqual(['two']);
    expect([...(view.installed ?? [])]).toEqual(['two']);
    // The owner's own view (hub scope) still lists the whole library.
    const hub = await skillsView(store, { kind: 'hub' } as Parameters<typeof skillsView>[1]);
    expect(hub.visible).toEqual(['one', 'two']);
  });
});

describe('skills page helpers', () => {
  const row = (r: Partial<CompareRow>): CompareRow => ({
    name: 'x',
    description: '',
    status: 'skipped',
    agents: [],
    ...r,
  });
  it('a skipped row says so, offers no move, and is never in Sync all', () => {
    expect(statusLabel(row({}), 'MacBook', true)).toBe('Skipped, not synced');
    expect(rowMoves(row({}))).toEqual([]);
    const plan = syncPlan([row({ name: 'a' }), row({ name: 'b', status: 'local-only' })]);
    expect(plan.pull).toEqual(['b']);
    expect(plan.skipped).toEqual([]);
  });
});
