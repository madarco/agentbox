import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { McpApprovalRequest, McpBoxScope } from '@agentbox/core';
import { treeHash, writeTar, type TarFile } from '@agentbox/sandbox-core';
import { createMcpServer, type McpHubScope, type McpScope } from '../lib/backend/mcp';
import { skillsMcpTools } from '../lib/backend/mcp-skills';
import { getSkillBindings, putSkillBindings } from '../lib/backend/skill-bindings';
import { createSkillProposals } from '../lib/backend/skill-proposals';
import {
  importSkill,
  readSkillMeta,
  type SkillsStore,
  type SkillsStoreEntry,
} from '../lib/backend/skills';

function memStore(): SkillsStore {
  const m = new Map<string, Buffer>();
  const entry = (path: string): SkillsStoreEntry => ({
    path,
    size: m.get(path)!.length,
    sha256: createHash('sha256').update(m.get(path)!).digest('hex'),
    updatedAt: '2026-11-23T00:00:00.000Z',
  });
  const put = (path: string, data: Buffer) => {
    const changed = !m.get(path)?.equals(data);
    m.set(path, data);
    return { ...entry(path), changed };
  };
  return {
    list: (prefix) =>
      Promise.resolve(
        [...m.keys()]
          .filter((p) => !prefix || p === prefix || p.startsWith(`${prefix}/`))
          .sort()
          .map(entry),
      ),
    get: (path) => Promise.resolve(m.has(path) ? { entry: entry(path), data: m.get(path)! } : null),
    put: (path, data) => Promise.resolve(put(path, data)),
    async putStream(path, body) {
      const chunks: Buffer[] = [];
      for await (const c of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
      return put(path, Buffer.concat(chunks));
    },
    getStream: (path) =>
      Promise.resolve(
        m.has(path) ? { entry: entry(path), data: Readable.from([m.get(path)!]) } : null,
      ),
    delete: (path) => Promise.resolve(m.delete(path)),
  };
}

function skillFiles(name: string, body = 'Do the thing.'): TarFile[] {
  return [
    {
      path: 'SKILL.md',
      mode: 0o644,
      data: Buffer.from(`---\nname: ${name}\ndescription: The ${name} skill\n---\n${body}\n`),
    },
    { path: 'notes/extra.txt', mode: 0o644, data: Buffer.from(`extra for ${name}\n`) },
  ];
}

async function addSkill(store: SkillsStore, name: string, body?: string): Promise<string> {
  const files = skillFiles(name, body);
  const sha = treeHash(files);
  await importSkill(store, {
    name,
    meta: { sha256: sha, description: `The ${name} skill`, size: 10, files: files.length },
    body: Readable.from([writeTar(files)]),
  });
  return sha;
}

/** A gate the test answers by hand. */
function gate() {
  const asked: McpApprovalRequest[] = [];
  let answer!: (v: boolean) => void;
  const approve = (req: McpApprovalRequest) => {
    asked.push(req);
    return new Promise<boolean>((r) => {
      answer = r;
    });
  };
  return { asked, approve, answer: (v: boolean) => answer(v) };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

function boxScope(over: Partial<McpBoxScope> = {}): McpBoxScope {
  return {
    kind: 'box',
    boxId: 'b1',
    boxName: 'box-one',
    repoKey: 'github.com/acme/app',
    origin: { boxId: 'b1', boxName: 'box-one' },
    approve: async () => false,
    redact: async (b) => b,
    skills: { boxId: 'b1', projectKey: 'github.com/acme/app' },
    ...over,
  };
}

const hubScope: McpHubScope = {
  kind: 'hub',
  origin: { boxId: null },
  approve: async () => false,
  redact: async (b) => b,
};

let nextId = 1;
async function call(store: SkillsStore, scope: McpScope, name: string, args: object = {}) {
  const server = createMcpServer({
    name: 't',
    version: '0',
    toolSets: [() => skillsMcpTools({ store: () => store })],
  });
  const reply = (await server.handle(
    { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
    scope,
  )) as { result: { structuredContent: Record<string, unknown>; isError?: boolean } };
  return reply.result;
}

const names = (r: { structuredContent: Record<string, unknown> }) =>
  (r.structuredContent.skills as { name: string }[]).map((s) => s.name);

describe('MCP skills tools', () => {
  it('shows a box only what its bindings allow, and what is installed', async () => {
    const store = memStore();
    for (const n of ['alpha', 'beta', 'gamma']) await addSkill(store, n);
    await putSkillBindings(store, { scope: 'global' }, { gamma: 'exclude' });
    await putSkillBindings(
      store,
      { scope: 'project', scopeId: 'github.com/acme/app' },
      { beta: 'exclude' },
    );
    const box = boxScope({
      skills: { boxId: 'b1', projectKey: 'github.com/acme/app', selection: { none: true } },
    });
    const list = await call(store, box, 'skills_list');
    expect(names(list)).toEqual(['alpha']);
    expect((list.structuredContent.skills as { installed: boolean }[])[0]!.installed).toBe(false);
    // The hub sees everything, with no `installed`.
    const all = await call(store, hubScope, 'skills_list');
    expect(names(all)).toEqual(['alpha', 'beta', 'gamma']);
    // A box with no skill context sees nothing.
    expect(names(await call(store, boxScope({ skills: undefined }), 'skills_list'))).toEqual([]);
  });

  it('reads SKILL.md and other files of a visible skill only', async () => {
    const store = memStore();
    await addSkill(store, 'alpha', 'Alpha body.');
    await addSkill(store, 'beta');
    await putSkillBindings(store, { scope: 'global' }, { beta: 'exclude' });
    const got = await call(store, boxScope(), 'skill_get', { name: 'alpha' });
    expect(got.structuredContent.content).toContain('Alpha body.');
    expect((got.structuredContent.files as { path: string }[]).map((f) => f.path)).toEqual([
      'SKILL.md',
      'notes/extra.txt',
    ]);
    const extra = await call(store, boxScope(), 'skill_get', {
      name: 'alpha',
      path: 'notes/extra.txt',
    });
    expect(extra.structuredContent.content).toBe('extra for alpha\n');
    const hidden = await call(store, boxScope(), 'skill_get', { name: 'beta' });
    expect(hidden.isError).toBe(true);
    expect(hidden.structuredContent.error).toMatch(/no skill 'beta' is available/);
  });

  it('installs a skill the create flags left out only after an approval', async () => {
    const store = memStore();
    await addSkill(store, 'alpha');
    const g = gate();
    const box = boxScope({
      approve: g.approve,
      skills: { boxId: 'b1', selection: { exclude: ['alpha'] } },
    });
    const r = await call(store, box, 'skills_propose_install', {
      name: 'alpha',
      reason: 'need it',
    });
    expect(r.structuredContent.status).toBe('pending');
    expect(g.asked[0]!.command).toBe('skills_propose_install');
    expect((await getSkillBindings(store)).box).toEqual({});
    g.answer(true);
    await settle();
    expect((await getSkillBindings(store)).box).toEqual({ b1: { alpha: 'include' } });
    const after = await call(store, box, 'skills_list');
    expect((after.structuredContent.skills as { installed: boolean }[])[0]!.installed).toBe(true);
    // Already installed: no second prompt.
    const again = await call(store, box, 'skills_propose_install', { name: 'alpha' });
    expect(again.structuredContent.status).toBe('installed');
    expect(g.asked).toHaveLength(1);
  });

  it('writes nothing when the install is declined, and refuses hub callers', async () => {
    const store = memStore();
    await addSkill(store, 'alpha');
    const g = gate();
    const box = boxScope({
      approve: g.approve,
      skills: { boxId: 'b1', selection: { none: true } },
    });
    await call(store, box, 'skills_propose_install', { name: 'alpha' });
    g.answer(false);
    await settle();
    expect((await getSkillBindings(store)).box).toEqual({});
    const hub = await call(store, hubScope, 'skills_propose_install', { name: 'alpha' });
    expect(hub.isError).toBe(true);
  });
});

describe('skill proposals', () => {
  const box = { id: 'b1', name: 'box-one' };

  it('stores a box-written skill only after one approval, at the hub-derived version', async () => {
    const store = memStore();
    const g = gate();
    const proposals = createSkillProposals({ store, approve: (_id, req) => g.approve(req) });
    const files = skillFiles('fresh');
    const r = await proposals.propose({ name: 'fresh', tarball: writeTar(files), box });
    expect(r).toMatchObject({ status: 'pending', isNew: true, version: treeHash(files) });
    expect(g.asked[0]!.message).toBe('Box box-one proposes a new library skill fresh');
    expect(g.asked[0]!.summary).toContain('The fresh skill');
    expect(await readSkillMeta(store, 'fresh')).toBeNull();
    // A second identical proposal waits on the same prompt.
    expect((await proposals.propose({ name: 'fresh', tarball: writeTar(files), box })).status).toBe(
      'pending',
    );
    expect(g.asked).toHaveLength(1);
    g.answer(true);
    await settle();
    const meta = await readSkillMeta(store, 'fresh');
    expect(meta?.current).toBe(treeHash(files));
    expect(meta?.versions[0]!.source.host).toBe('box box-one');
    expect(proposals.pending()).toBe(0);
    // The same version again: nothing to ask.
    expect((await proposals.propose({ name: 'fresh', tarball: writeTar(files), box })).status).toBe(
      'unchanged',
    );
    expect(g.asked).toHaveLength(1);
  });

  it('stores nothing on a no, and drops an approval whose base moved', async () => {
    const store = memStore();
    await addSkill(store, 'alpha');
    const g = gate();
    const proposals = createSkillProposals({ store, approve: (_id, req) => g.approve(req) });
    await proposals.propose({ name: 'alpha', tarball: writeTar(skillFiles('alpha', 'v2')), box });
    expect(g.asked[0]!.message).toContain('a new version of library skill alpha');
    g.answer(false);
    await settle();
    const before = (await readSkillMeta(store, 'alpha'))!.current;
    expect(before).toBe(treeHash(skillFiles('alpha')));

    await proposals.propose({ name: 'alpha', tarball: writeTar(skillFiles('alpha', 'v3')), box });
    const moved = await addSkill(store, 'alpha', 'from a PC');
    g.answer(true);
    await settle();
    expect((await readSkillMeta(store, 'alpha'))!.current).toBe(moved);
  });

  it('refuses reserved names, a name mismatch and a skill without SKILL.md', async () => {
    const store = memStore();
    const proposals = createSkillProposals({ store, approve: async () => true });
    await expect(
      proposals.propose({ name: 'agentbox-x', tarball: writeTar(skillFiles('agentbox-x')), box }),
    ).rejects.toThrow(/reserved/);
    await expect(
      proposals.propose({ name: 'one', tarball: writeTar(skillFiles('two')), box }),
    ).rejects.toThrow(/names itself 'two'/);
    await expect(
      proposals.propose({
        name: 'one',
        tarball: writeTar([{ path: 'x.md', mode: 0o644, data: Buffer.from('x') }]),
        box,
      }),
    ).rejects.toThrow(/no SKILL.md/);
  });

  it('shows the secret scan findings to the approver', async () => {
    const store = memStore();
    const g = gate();
    const proposals = createSkillProposals({ store, approve: (_id, req) => g.approve(req) });
    const files = [
      ...skillFiles('leaky'),
      {
        path: 'run.sh',
        mode: 0o755,
        data: Buffer.from('export API_KEY=Zx81kQ0pLm2Nv7Rt5Yw3Bc9Df4Gh6Jk\n'),
      },
    ];
    const r = await proposals.propose({ name: 'leaky', tarball: writeTar(files), box });
    expect(r.findings.length).toBeGreaterThan(0);
    expect(g.asked[0]!.detail).toMatch(/secret scan: \d+ finding/);
  });
});
