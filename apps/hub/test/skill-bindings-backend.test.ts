import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  getSkillBindings,
  parseBindingChanges,
  parseBindingTarget,
  previewSkillSet,
  putSkillBindings,
} from '../lib/backend/skill-bindings';
import {
  importSkill,
  SkillsError,
  type SkillsStore,
  type SkillsStoreEntry,
} from '../lib/backend/skills';

function memStore(): SkillsStore {
  const m = new Map<string, Buffer>();
  const entry = (path: string): SkillsStoreEntry => ({
    path,
    size: m.get(path)!.length,
    sha256: createHash('sha256').update(m.get(path)!).digest('hex'),
    updatedAt: '',
  });
  const put = (path: string, data: Buffer) => {
    const changed = !m.get(path)?.equals(data);
    m.set(path, data);
    return { ...entry(path), changed };
  };
  return {
    list: async (prefix) =>
      [...m.keys()]
        .filter((p) => !prefix || p === prefix || p.startsWith(`${prefix}/`))
        .sort()
        .map(entry),
    get: async (path) => (m.has(path) ? { entry: entry(path), data: m.get(path)! } : null),
    put: async (path, data) => put(path, data),
    async putStream(path, body) {
      const chunks: Buffer[] = [];
      for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
      return put(path, Buffer.concat(chunks));
    },
    getStream: async (path) =>
      m.has(path) ? { entry: entry(path), data: Readable.from(m.get(path)!) } : null,
    delete: async (path) => m.delete(path),
  };
}

async function seed(store: SkillsStore, ...names: string[]) {
  for (const name of names) {
    await importSkill(store, {
      name,
      meta: { sha256: name[0]!.repeat(64), description: `${name} skill`, size: 1, files: 1 },
      body: Readable.from(Buffer.from(name)),
    });
  }
}

describe('skill bindings backend', () => {
  it('validates the target and the body', () => {
    expect(parseBindingTarget('global', null)).toEqual({ scope: 'global' });
    expect(parseBindingTarget('project', 'github.com/acme/app')).toEqual({
      scope: 'project',
      scopeId: 'github.com/acme/app',
    });
    expect(() => parseBindingTarget('team', 'x')).toThrow(SkillsError);
    expect(() => parseBindingTarget('workspace', 'nothex')).toThrow(/16-hex/);
    expect(parseBindingChanges({ bindings: { alpha: 'include', beta: null } })).toEqual({
      alpha: 'include',
      beta: null,
    });
    expect(() => parseBindingChanges({ bindings: { 'agentbox-setup': 'include' } })).toThrow(
      /reserved/,
    );
    expect(() => parseBindingChanges({ bindings: { alpha: 'on' } })).toThrow(/mode/);
    expect(() => parseBindingChanges({ bindings: {} })).toThrow(/empty/);
    expect(() => parseBindingChanges({})).toThrow(SkillsError);
  });

  it('merges writes per scope and previews the resolved set', async () => {
    const store = memStore();
    await seed(store, 'alpha', 'beta');
    await putSkillBindings(store, { scope: 'global' }, { alpha: 'exclude' });
    const ws = 'a1b2c3d4e5f60718';
    await Promise.all([
      putSkillBindings(store, { scope: 'workspace', scopeId: ws }, { alpha: 'include' }),
      putSkillBindings(
        store,
        { scope: 'project', scopeId: 'github.com/acme/app' },
        { beta: 'exclude' },
      ),
    ]);
    const doc = await getSkillBindings(store);
    expect(doc.global).toEqual({ alpha: 'exclude' });
    expect(doc.workspace[ws]).toEqual({ alpha: 'include' });
    expect(doc.project['github.com/acme/app']).toEqual({ beta: 'exclude' });

    const plain = await previewSkillSet(store, {});
    expect(plain.skills.map((s) => [s.name, s.included, s.from])).toEqual([
      ['alpha', false, 'global'],
      ['beta', true, 'default'],
    ]);
    const inWs = await previewSkillSet(store, {
      repo: 'git@github.com:acme/app.git',
      workspaceId: ws,
    });
    expect(inWs.projectKey).toBe('github.com/acme/app');
    expect(inWs.skills.map((s) => [s.name, s.included, s.from, s.description])).toEqual([
      ['alpha', true, 'workspace', 'alpha skill'],
      ['beta', false, 'project', 'beta skill'],
    ]);
  });

  it('reports no library before the first import', async () => {
    expect((await previewSkillSet(memStore(), {})).library).toBe(false);
  });

  it('refuses to write over a bindings file it cannot read', async () => {
    const store = memStore();
    await store.put('skills/.bindings.json', Buffer.from('{broken'));
    await expect(
      putSkillBindings(store, { scope: 'global' }, { alpha: 'exclude' }),
    ).rejects.toThrow(/not valid JSON/);
    expect((await store.get('skills/.bindings.json'))!.data.toString()).toBe('{broken');
  });
});
