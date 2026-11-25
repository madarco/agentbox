import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { executePcSkillsAction, isPcSkillsMethod } from '@agentbox/relay';
import { treeHash, writeTar, type AgentSkillDirs } from '@agentbox/sandbox-core';
import { importSkill, listSkills, readSkillMeta } from '../lib/backend/skills';
import { createPcSkillsBackend, type PcReach } from '../lib/backend/skills-pc';
import { syncSkillBoxes } from '../lib/backend/skill-boxes';
import { memStore } from './_skills-mem-store';

const AGENTS: AgentSkillDirs[] = [{ id: 'codex', dirs: ['.agents/skills'] }];
const md = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\nDo it.\n`;

/** A skill with `bytes` of incompressible payload, so the tarball is about that big. */
function bigSkill(name: string, bytes: number) {
  const files = [
    { path: 'SKILL.md', mode: 0o644, data: Buffer.from(md(name)) },
    { path: 'assets/blob.bin', mode: 0o644, data: randomBytes(bytes) },
  ];
  return { files, sha: treeHash(files), tar: writeTar(files) };
}

const meta = (sha: string, size = 1) => ({
  sha256: sha,
  description: 'd',
  size,
  files: 2,
  source: { host: 'mac' },
});

describe('skill upload integrity', () => {
  it('stores a ~20 MB skill whole', async () => {
    const store = memStore();
    const s = bigSkill('large', 20 * 1024 * 1024);
    // Chunked like a real request body.
    const chunks: Buffer[] = [];
    for (let i = 0; i < s.tar.length; i += 64 * 1024) chunks.push(s.tar.subarray(i, i + 64 * 1024));
    const r = await importSkill(store, {
      name: 'large',
      meta: meta(s.sha),
      body: Readable.from(chunks),
      expectedBytes: s.tar.length,
      maxBytes: 100 * 1024 * 1024,
    });
    expect(r.changed).toBe(true);
    const stored = await store.get(`skills/large/${s.sha}.tar.gz`);
    expect(stored?.data.length).toBe(s.tar.length);
    expect(() => gunzipSync(stored!.data)).not.toThrow();
    expect((await readSkillMeta(store, 'large'))?.versions[0]).toMatchObject({
      tarballBytes: s.tar.length,
      verified: true,
    });
  });

  it('refuses a body shorter than its Content-Length and stores nothing', async () => {
    const store = memStore();
    const s = bigSkill('cut', 64 * 1024);
    await expect(
      importSkill(store, {
        name: 'cut',
        meta: meta(s.sha),
        body: Readable.from([s.tar.subarray(0, 1000)]),
        expectedBytes: s.tar.length,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/cut short/),
    });
    expect(store.paths()).toEqual([]);
  });

  it('refuses a truncated tarball even with no declared length', async () => {
    const store = memStore();
    const s = bigSkill('cut', 64 * 1024);
    await expect(
      importSkill(store, {
        name: 'cut',
        meta: meta(s.sha),
        body: Readable.from([s.tar.subarray(0, s.tar.length - 100)]),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(store.paths()).toEqual([]);
  });

  it('refuses a tarball that is not the version it names', async () => {
    const store = memStore();
    const a = bigSkill('a', 10);
    const b = bigSkill('b', 10);
    await expect(
      importSkill(store, { name: 'a', meta: meta(a.sha), body: Readable.from([b.tar]) }),
    ).rejects.toThrow(/not the version it names/);
    expect(store.paths()).toEqual([]);
  });

  it('the cap is on the compressed blob: a text-heavy skill over it unpacked still imports', async () => {
    const store = memStore();
    const files = [
      { path: 'SKILL.md', mode: 0o644, data: Buffer.from(md('text')) },
      { path: 'ref.md', mode: 0o644, data: Buffer.alloc(4 * 1024 * 1024, 'a') },
    ];
    const tar = writeTar(files);
    expect(tar.length).toBeLessThan(1024 * 1024);
    const r = await importSkill(store, {
      name: 'text',
      meta: meta(treeHash(files)),
      body: Readable.from([tar]),
      maxBytes: 1024 * 1024,
    });
    expect(r.changed).toBe(true);
  });

  it('refuses a body longer than declared', async () => {
    const store = memStore();
    const s = bigSkill('long', 1024);
    await expect(
      importSkill(store, {
        name: 'long',
        meta: meta(s.sha),
        body: Readable.from([s.tar, Buffer.from('extra')]),
        expectedBytes: s.tar.length,
      }),
    ).rejects.toThrow(/longer than declared/);
    expect(store.paths()).toEqual([]);
  });

  it('a skill over 100 MiB unpacked is refused as too large, not as the wrong version', async () => {
    const store = memStore();
    const files = [
      { path: 'SKILL.md', mode: 0o644, data: Buffer.from(md('huge')) },
      { path: 'ref.md', mode: 0o644, data: Buffer.alloc(101 * 1024 * 1024, 'a') },
    ];
    const tar = writeTar(files);
    const err = await importSkill(store, {
      name: 'huge',
      meta: meta(treeHash(files)),
      body: Readable.from([tar]),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'payload_too_large' });
    expect(String((err as Error).message)).toMatch(/larger than 100 MiB unpacked/);
    expect(String((err as Error).message)).not.toMatch(/not the version/);
  });

  it('refuses a body over the cap with payload_too_large', async () => {
    const store = memStore();
    const s = bigSkill('big', 64 * 1024);
    await expect(
      importSkill(store, {
        name: 'big',
        meta: meta(s.sha),
        body: Readable.from([s.tar]),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'payload_too_large' });
  });
});

/** Make the stored current version look like one stored truncated before imports were verified. */
async function breakStored(store: ReturnType<typeof memStore>, name: string) {
  const m = (await readSkillMeta(store, name))!;
  const v = m.versions.find((x) => x.sha256 === m.current)!;
  const path = `skills/${name}/${v.sha256}.tar.gz`;
  const full = (await store.get(path))!.data;
  const cut = full.subarray(0, Math.floor(full.length / 2));
  await store.put(path, cut);
  const { verified: _v, ...legacy } = v;
  await store.put(
    `skills/${name}/meta.json`,
    Buffer.from(
      JSON.stringify({
        ...m,
        versions: m.versions.map((x) => (x === v ? { ...legacy, tarballBytes: cut.length } : x)),
      }),
    ),
  );
}

function pcSetup() {
  const home = mkdtempSync(join(tmpdir(), 'hub-integrity-'));
  const store = memStore();
  const runSelf = async (method: string, params: unknown): Promise<PcReach> => {
    if (!isPcSkillsMethod(method)) throw new Error(method);
    return { kind: 'result', ...(await executePcSkillsAction(method, params, { home })) };
  };
  const backend = createPcSkillsBackend({
    store: () => store,
    self: () => ({ id: 'self-id', label: 'devbox' }),
    devices: () => [],
    present: () => [],
    runSelf,
    skillsChanged: () => undefined,
    agentDirs: () => AGENTS,
  });
  return { home, store, backend };
}

describe('a library entry stored truncated', () => {
  it('shows as broken, differs from the PC, refuses Send, and a Pull repairs it', async () => {
    const { home, store, backend } = pcSetup();
    mkdirSync(join(home, '.agents/skills/fix-me'), { recursive: true });
    writeFileSync(join(home, '.agents/skills/fix-me/SKILL.md'), md('fix-me'));
    await backend.pullSkills('self-id', ['fix-me']);
    await breakStored(store, 'fix-me');

    const listed = (await listSkills(store)).skills[0]!;
    expect(listed.broken).toMatch(/gzip|tar|unexpected end/i);
    // Recorded once, so the next listing doesn't re-read the blob.
    expect((await readSkillMeta(store, 'fix-me'))?.versions[0]?.broken).toBe(listed.broken);

    const c = await backend.compareMachineSkills('self-id');
    expect(c.rows[0]).toMatchObject({
      status: 'differs',
      newer: 'local',
      hub: { broken: listed.broken },
    });

    const [sent] = await backend.sendSkills('self-id', ['fix-me'], { overwrite: true });
    expect(sent).toMatchObject({ status: 'failed', reason: expect.stringMatching(/broken/) });

    const [pulled] = await backend.pullSkills('self-id', ['fix-me']);
    expect(pulled).toMatchObject({ status: 'imported' });
    expect((await listSkills(store)).skills[0]!.broken).toBeUndefined();
    expect((await backend.compareMachineSkills('self-id')).rows[0]!.status).toBe('same');
  });

  it('a Pull that repairs the current version re-syncs every box holding it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hub-repair-'));
    const store = memStore();
    const repaired: string[][] = [];
    const changed: string[][] = [];
    const backend = createPcSkillsBackend({
      store: () => store,
      self: () => ({ id: 'self-id', label: 'devbox' }),
      devices: () => [],
      present: () => [],
      runSelf: async (method: string, params: unknown): Promise<PcReach> => {
        if (!isPcSkillsMethod(method)) throw new Error(method);
        return { kind: 'result', ...(await executePcSkillsAction(method, params, { home })) };
      },
      skillsChanged: (n) => changed.push(n),
      skillsRepaired: (n) => repaired.push(n),
      agentDirs: () => AGENTS,
    });
    mkdirSync(join(home, '.agents/skills/fix-me'), { recursive: true });
    writeFileSync(join(home, '.agents/skills/fix-me/SKILL.md'), md('fix-me'));
    await backend.pullSkills('self-id', ['fix-me']);
    expect(changed).toEqual([['fix-me']]);
    const version = (await readSkillMeta(store, 'fix-me'))!.current;
    await breakStored(store, 'fix-me');

    // b1 was served the version (its install failed on the cut blob): not behind.
    await store.put(
      'boxes/b1/skills.json',
      Buffer.from(JSON.stringify({ at: 't', skills: { 'fix-me': version } })),
    );
    await store.put(
      'boxes/b2/skills.json',
      Buffer.from(JSON.stringify({ at: 't', skills: { other: version } })),
    );

    const [r] = await backend.pullSkills('self-id', ['fix-me']);
    expect(r).toMatchObject({ status: 'imported' });
    expect(changed).toEqual([['fix-me']]);
    expect(repaired).toEqual([['fix-me']]);

    const deps = {
      store,
      boxIds: () => Promise.resolve(['b1', 'b2']),
      probeState: () => Promise.resolve('running'),
      exec: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      log: () => undefined,
    };
    // The plain "changed" fan-out would miss b1; the repair fan-out reaches it.
    expect(await syncSkillBoxes(deps, { names: ['fix-me'] })).toEqual([]);
    const out = await syncSkillBoxes(deps, { holding: ['fix-me'] });
    expect(out.map((o) => o.boxId)).toEqual(['b1']);

    // Re-uploading identical bytes is no repair.
    const again = await backend.pullSkills('self-id', ['fix-me']);
    expect(again[0]).toMatchObject({ status: 'unchanged' });
    expect(repaired).toHaveLength(1);
  });

  it('a missing blob shows as broken but is not recorded', async () => {
    const store = memStore();
    const s = bigSkill('gone', 10);
    await importSkill(store, { name: 'gone', meta: meta(s.sha), body: Readable.from([s.tar]) });
    const m = (await readSkillMeta(store, 'gone'))!;
    const { verified: _v, ...legacy } = m.versions[0]!;
    await store.put(
      'skills/gone/meta.json',
      Buffer.from(JSON.stringify({ ...m, versions: [legacy] })),
    );
    await store.delete(`skills/gone/${s.sha}.tar.gz`);
    expect((await listSkills(store)).skills[0]!.broken).toMatch(/missing/);
    expect((await readSkillMeta(store, 'gone'))?.versions[0]?.broken).toBeUndefined();
  });

  it('a stored entry that checks out is marked verified, not broken', async () => {
    const store = memStore();
    const s = bigSkill('ok', 10);
    await importSkill(store, { name: 'ok', meta: meta(s.sha), body: Readable.from([s.tar]) });
    const m = (await readSkillMeta(store, 'ok'))!;
    const { verified: _v, ...legacy } = m.versions[0]!;
    await store.put(
      'skills/ok/meta.json',
      Buffer.from(JSON.stringify({ ...m, versions: [legacy] })),
    );
    expect((await listSkills(store)).skills[0]!.broken).toBeUndefined();
    expect((await readSkillMeta(store, 'ok'))?.versions[0]?.verified).toBe(true);
  });
});
