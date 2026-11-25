import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The upload path reads (and may mint) ~/.agentbox/machine-id; never let it touch
// the real home. Hoisted so it runs before any module computes a state dir.
vi.hoisted(() => {
  // A path is enough: everything under it is created on demand. No imports are
  // available yet at hoist time, so build it from the environment directly.
  const base = process.env.TMPDIR ?? '/tmp';
  process.env.HOME = `${base}/skills-lib-home-${String(process.pid)}-${String(Date.now())}`;
});

import {
  readTar,
  SkillTarError,
  writeTar,
  discoverLocalSkills,
  parseSkillFrontmatter,
  readSkillTree,
  scanSkillFiles,
  shannonEntropy,
  SkillTooLargeError,
  treeHash,
} from '@agentbox/sandbox-core';
import {
  compareSkills,
  downloadHubSkill,
  seedSkillsIfEmpty,
  uploadBlocker,
} from '../src/lib/skills/sync.js';
import type { HubApiClient, HubApiSkill } from '../src/control-plane/hub-api-client.js';
import { rememberSeeded, seededHubs } from '../src/lib/skills/auto-seed.js';
import { gzipSync } from 'node:zlib';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkill(
  root: string,
  name: string,
  extra: Record<string, string> = {},
  fm?: string,
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    fm ?? `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nBody.\n`,
  );
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe('frontmatter', () => {
  it('reads plain, quoted and folded values', () => {
    expect(
      parseSkillFrontmatter('---\nname: "screenshot"\ndescription: \'Takes shots\'\n---\n'),
    ).toEqual({
      name: 'screenshot',
      description: 'Takes shots',
    });
    expect(
      parseSkillFrontmatter(
        '---\nname: x\ndescription: >\n  line one\n  line two\nlicense: MIT\n---\n',
      ),
    ).toEqual({ name: 'x', description: 'line one line two' });
    expect(parseSkillFrontmatter('no frontmatter')).toBeNull();
  });
});

describe('tar', () => {
  it('round-trips files, modes and long paths, deterministically', () => {
    const long = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.md`;
    const files = [
      { path: 'SKILL.md', mode: 0o644, data: Buffer.from('hello') },
      { path: 'scripts/run.sh', mode: 0o755, data: Buffer.from('#!/bin/sh\n') },
      { path: long, mode: 0o644, data: Buffer.alloc(1300, 7) },
    ];
    const a = writeTar(files);
    expect(writeTar([...files].reverse()).equals(a)).toBe(true);
    const back = readTar(a);
    expect(back.map((f) => [f.path, f.mode, f.data.length])).toEqual([
      ['SKILL.md', 0o644, 5],
      [long, 0o644, 1300],
      ['scripts/run.sh', 0o755, 10],
    ]);
  });

  it('refuses unsafe paths on write', () => {
    expect(() => writeTar([{ path: '../x', mode: 0o644, data: Buffer.alloc(0) }])).toThrow(
      SkillTarError,
    );
    expect(() => writeTar([{ path: '/abs', mode: 0o644, data: Buffer.alloc(0) }])).toThrow(
      SkillTarError,
    );
  });

  it('refuses a symlink entry and a dotdot path on read', () => {
    const tar = readTarFixture('link', '2');
    expect(() => readTar(tar)).toThrow(/non-regular/);
    expect(() => readTar(readTarFixture('../evil', '0'))).toThrow(/unsafe path/);
    expect(() => readTar(Buffer.from('not gzip'))).toThrow(SkillTarError);
  });
});

/** A hand-built one-entry tar with an arbitrary name and type flag. */
function readTarFixture(name: string, type: string): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write('00000000000\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([h, Buffer.alloc(1024, 0)]));
}

describe('tree hash', () => {
  it('is independent of mtimes and of where the tree lives, and follows in-skill links', async () => {
    const a = writeSkill(tmp('ska-'), 'one', { 'refs/a.md': 'A' });
    // Same content, but refs/a.md is a link to a file elsewhere INSIDE the skill,
    // and the skill root itself is reached through a link (the usual
    // ~/.claude/skills/x -> ~/.agents/skills/x layout).
    const real = writeSkill(tmp('skb-'), 'one', { 'store/a.md': 'A' });
    mkdirSync(join(real, 'refs'));
    symlinkSync(join(real, 'store', 'a.md'), join(real, 'refs', 'a.md'));
    const linkedRoot = join(tmp('skl-'), 'one');
    symlinkSync(real, linkedRoot);
    const ha = treeHash((await readSkillTree(a)).files);
    const hb = treeHash(
      (await readSkillTree(linkedRoot)).files.filter((f) => !f.path.startsWith('store/')),
    );
    expect(ha).toBe(hb);
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses links out of the skill, and the skill with them is not uploadable', async () => {
    const outside = tmp('skout-');
    writeFileSync(join(outside, '.env'), 'API_KEY=whatever');
    const home = tmp('skhome-');
    const d = writeSkill(join(home, '.agents/skills'), 'leaky-link');
    symlinkSync(outside, join(d, 'refs'));
    const tree = await readSkillTree(d);
    expect(tree.outOfTreeLinks).toEqual(['refs']);
    expect(tree.files.map((f) => f.path)).toEqual(['SKILL.md']);
    const [skill] = await discoverLocalSkills({ home });
    expect(uploadBlocker(skill!)).toMatch(/symlink points outside the skill: refs/);
  });

  it('keeps content reached through two links to one directory, and stops cycles', async () => {
    const d = writeSkill(tmp('skshared-'), 'one', { 'shared/x.md': 'X' });
    mkdirSync(join(d, 'templates'));
    symlinkSync(join(d, 'shared'), join(d, 'templates', 'a'));
    symlinkSync(join(d, 'shared'), join(d, 'templates', 'b'));
    symlinkSync(d, join(d, 'shared', 'loop'));
    const paths = (await readSkillTree(d)).files.map((f) => f.path).sort();
    expect(paths).toEqual(['SKILL.md', 'shared/x.md', 'templates/a/x.md', 'templates/b/x.md']);
  });

  it('reports broken links and enforces the size cap', async () => {
    const d = writeSkill(tmp('skc-'), 'one');
    symlinkSync('/nonexistent/x', join(d, 'gone.md'));
    expect((await readSkillTree(d)).brokenLinks).toEqual(['gone.md']);
    await expect(readSkillTree(d, { maxBytes: 3 })).rejects.toBeInstanceOf(SkillTooLargeError);
  });

  it('the hash of extracted files equals the hash of the source tree', async () => {
    const d = writeSkill(tmp('skd-'), 'one', { 'scripts/x.sh': 'echo' });
    const tree = await readSkillTree(d);
    expect(treeHash(readTar(writeTar(tree.files)))).toBe(treeHash(tree.files));
  });
});

describe('secret scan', () => {
  const file = (path: string, text: string) => ({ path, data: Buffer.from(text) });
  it('flags real-looking secrets with rule, path and line only', () => {
    const key = 'ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF3hJ5';
    const f = scanSkillFiles([file('SKILL.md', `line one\nexport GITHUB_TOKEN=${key}\n`)]);
    expect(f).toEqual([
      { rule: 'github-token', path: 'SKILL.md', line: 2 },
      { rule: 'env-assignment', path: 'SKILL.md', line: 2 },
    ]);
    expect(JSON.stringify(f)).not.toContain(key);
  });

  it('flags a private key body but not a placeholder one', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'.repeat(3);
    expect(
      scanSkillFiles([
        file('k.md', `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`),
      ]),
    ).toHaveLength(1);
    expect(
      scanSkillFiles([
        file(
          'k.md',
          '-----BEGIN PRIVATE KEY-----\n<YOUR_OPENVPN_CLIENT_PRIVATE_KEY>\n-----END PRIVATE KEY-----',
        ),
      ]),
    ).toEqual([]);
  });

  it('suppresses placeholders, git SHAs and test fixtures', () => {
    expect(
      scanSkillFiles([file('a.md', "curl -H 'Authorization: Bearer YOUR_API_KEY_GOES_HERE_1234'")]),
    ).toEqual([]);
    expect(
      scanSkillFiles([file('a.json', '"token": "0123456789abcdef0123456789abcdef01234567"')]),
    ).toEqual([]);
    const fixture = 'sk-ant-' + 'Zq8Lm2Np4Rs6Tv8Xz0Bd2Fh4Jk6Mn8Pq0St2Vx4Za';
    expect(scanSkillFiles([file('tests/redaction.test.ts', `const t = "${fixture}"`)])).toEqual([]);
    expect(scanSkillFiles([file('src/x.ts', `const t = "${fixture}"`)])).toHaveLength(1);
  });

  it('catches the .env-style secrets the PR #434 review found missed', () => {
    // The review's examples, each previously returning [] for a file named `.env`.
    const rules = (text: string, path = 'scripts/config.txt') =>
      scanSkillFiles([file(path, text)]).map((f) => f.rule);
    expect(rules('API_KEY=Zk3q9XbP2mLw7RtY8vN4cJ6hD1sF0gQa')).toEqual(['env-assignment']);
    expect(rules('REPLICATE_API_TOKEN=r8_Hk2Lm9Pq4Rt7Vx1Zb3Nd6Fg8Jw0Ys5Ce2')).toEqual([
      'env-assignment',
    ]);
    expect(rules('DATABASE_URL=postgres://admin:S3cr3tPassw0rd!@db.internal:5432/app')).toEqual([
      'url-credentials',
    ]);
    expect(rules('token: Zk3q9XbP2mLw7RtY8vN4cJ6hD1sF0gQa')).toEqual(['env-assignment']);
    expect(rules('  export FAL_KEY=a1B2c3D4e5F6g7H8i9J0kLmN')).toEqual(['env-assignment']);
    // And in a file named `.env`, the name alone is a finding too.
    expect(rules('API_KEY=Zk3q9XbP2mLw7RtY8vN4cJ6hD1sF0gQa', '.env')).toEqual([
      'secret-file',
      'env-assignment',
    ]);
  });

  it('flags credential files by name, not templates or public keys', () => {
    const named = (path: string) =>
      scanSkillFiles([file(path, 'nothing secret in here')]).some((f) => f.rule === 'secret-file');
    for (const p of [
      '.env',
      '.env.local',
      'scripts/.env.production',
      'certs/server.pem',
      'tls.key',
      'id_rsa',
      'keys/id_ed25519',
      '.netrc',
      '.npmrc',
      '.pypirc',
      'credentials.json',
      'gcp/credentials-prod.json',
    ]) {
      expect(named(p), p).toBe(true);
    }
    for (const p of [
      '.env.example',
      '.env.sample',
      'id_rsa.pub',
      'keys.md',
      'SKILL.md',
      'monkey.ts',
    ]) {
      expect(named(p), p).toBe(false);
    }
  });

  it('keeps the placeholder filters for the new rules', () => {
    const none = (text: string) => expect(scanSkillFiles([file('.env.example', text)])).toEqual([]);
    none('API_KEY=your-api-key-here-xxxxxxxx');
    none('API_KEY=<YOUR_API_KEY_GOES_HERE>');
    none('OPENAI_API_KEY=$OPENAI_API_KEY_FROM_THE_ENV');
    none('TOKEN=${GITHUB_TOKEN_FROM_ENVIRONMENT}');
    none('SSH_KEY_PATH=~/.ssh/id_ed25519_for_deploys');
    none('PASSWORD=aaaaaaaaaaaaaaaaaaaa');
    none('DATABASE_URL=postgres://user:password@localhost:5432/app');
    none('REDIS_URL=redis://default:${REDIS_PASSWORD}@redis:6379');
    none('commit: 0123456789abcdef0123456789abcdef01234567');
    // Source code, not literals (each was a real false positive in Phase 1 data).
    none('    api_key = get_api_key(args.api_key)');
    none('    combineTokensWithinMilliseconds: SWITCH_CAPTIONS_EVERY_MS,');
    none('      total_tokens: s.subagentTokens,');
    none('    unexpected_keys = set(frontmatter.keys()) - ALLOWED_PROPERTIES');
  });

  it('skips binary files', () => {
    expect(
      scanSkillFiles([
        { path: 'a.png', data: Buffer.from([0, 1, 2, ...Buffer.from('AKIAABCDEFGHIJKLMNOP')]) },
      ]),
    ).toEqual([]);
  });

  it('entropy is low for repeated text', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('aB3dE5gH7jK9')).toBeGreaterThan(3.5);
  });
});

describe('discoverLocalSkills', () => {
  it('folds duplicates by name, skips reserved/synced/dot and invalid folders', async () => {
    const home = tmp('skh-');
    writeSkill(join(home, '.agents/skills'), 'one');
    writeSkill(join(home, '.agents/skills'), 'agentbox-setup');
    writeSkill(join(home, '.agents/skills'), 'agentbox');
    mkdirSync(join(home, '.agents/skills/.system/x'), { recursive: true });
    mkdirSync(join(home, '.agents/skills/no-skill-md'), { recursive: true });
    writeSkill(join(home, '.claude/skills'), 'one');
    writeSkill(join(home, '.claude/skills/synced/org_1'), 'docx');
    writeSkill(join(home, '.codex/skills'), 'two', {}, '---\nname: other\ndescription: d\n---\n');
    const skills = await discoverLocalSkills({ home });
    expect(skills.map((s) => s.name)).toEqual(['one', 'two']);
    expect(skills[0]!.alsoAt).toEqual([{ dir: join(home, '.claude/skills/one'), same: true }]);
    expect(skills[1]!.problems[0]).toMatch(/frontmatter name 'other'/);
    expect(uploadBlocker(skills[1]!)).toMatch(/frontmatter/);
    expect(uploadBlocker(skills[0]!)).toBeNull();
  });
});

const hubSkill = (
  name: string,
  current: string,
  updatedAt = '2026-01-01T00:00:00Z',
): HubApiSkill => ({
  name,
  description: 'd',
  current,
  size: 1,
  files: 1,
  tarballBytes: 1,
  updatedAt,
  source: { host: 'mac' },
  versions: 1,
});

describe('compareSkills', () => {
  it('classifies rows', async () => {
    const home = tmp('skcmp-');
    writeSkill(join(home, '.agents/skills'), 'both');
    writeSkill(join(home, '.agents/skills'), 'changed');
    writeSkill(join(home, '.agents/skills'), 'mine');
    const local = await discoverLocalSkills({ home });
    const both = local.find((s) => s.name === 'both')!;
    const rows = compareSkills(local, [
      hubSkill('both', both.treeSha),
      hubSkill('changed', 'f'.repeat(64)),
      hubSkill('theirs', 'e'.repeat(64)),
    ]);
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ['both', 'same'],
      ['changed', 'differs'],
      ['mine', 'local-only'],
      ['theirs', 'hub-only'],
    ]);
    expect(rows[1]!.newer).toBe('local');
  });
});

/** A fake hub client over an in-memory library. */
function fakeClient(seeded = false) {
  const store = new Map<string, { version: string; data: Buffer; meta: { description: string } }>();
  let isSeeded = seeded;
  const client = {
    listSkills: () =>
      Promise.resolve({
        seeded: isSeeded,
        skills: [...store.entries()].map(([name, v]) => hubSkill(name, v.version)),
      }),
    uploadSkill: (name: string, data: Buffer, meta: { sha256: string; description: string }) => {
      const prev = store.get(name);
      store.set(name, { version: meta.sha256, data, meta });
      isSeeded = true;
      return Promise.resolve({
        name,
        version: meta.sha256,
        changed: prev?.version !== meta.sha256,
        skill: hubSkill(name, meta.sha256),
      });
    },
    downloadSkill: (name: string) => {
      const v = store.get(name);
      if (!v) return Promise.reject(new Error('not found'));
      return Promise.resolve({ version: v.version, data: v.data });
    },
    discardSkill: (name: string) => Promise.resolve({ name, removed: store.delete(name) ? 2 : 0 }),
  };
  return { client: client as unknown as HubApiClient, store };
}

describe('seed + download', () => {
  it('seeds clean skills once, skipping flagged ones', async () => {
    const home = tmp('skseed-');
    writeSkill(join(home, '.agents/skills'), 'clean');
    const key = 'AKIA' + 'Q7RTX2ZPLM4WNB8D';
    writeSkill(join(home, '.agents/skills'), 'leaky', { 'notes.md': `aws_key = ${key}` });
    const { client, store } = fakeClient();
    const out = await seedSkillsIfEmpty(client, { home, maxBytes: 1 << 20 });
    expect(out?.uploaded).toEqual(['clean']);
    expect(out?.skipped.map((s) => s.name)).toEqual(['leaky']);
    expect(out?.skipped[0]!.reason).toMatch(/aws-access-key in notes.md:1/);
    expect([...store.keys()]).toEqual(['clean']);
    // Seeded now: a second run does nothing.
    expect(await seedSkillsIfEmpty(client, { home, maxBytes: 1 << 20 })).toBeNull();
  });

  it('does nothing on an already-seeded (even empty) library', async () => {
    const home = tmp('skseed2-');
    writeSkill(join(home, '.agents/skills'), 'clean');
    const { client, store } = fakeClient(true);
    expect(await seedSkillsIfEmpty(client, { home, maxBytes: 1 << 20 })).toBeNull();
    expect(store.size).toBe(0);
  });

  it('downloads to ~/.agents/skills, links for claude, and respects local changes', async () => {
    const pcA = tmp('skpca-');
    writeSkill(join(pcA, '.agents/skills'), 'shared', { 'scripts/run.sh': 'echo hi' });
    const { client } = fakeClient();
    await seedSkillsIfEmpty(client, { home: pcA, maxBytes: 1 << 20 });

    const pcB = tmp('skpcb-');
    mkdirSync(join(pcB, '.claude'));
    const got = await downloadHubSkill(client, 'shared', { home: pcB, maxBytes: 1 << 20 });
    expect(got).toMatchObject({ status: 'installed', dir: join(pcB, '.agents/skills/shared') });
    expect(readFileSync(join(pcB, '.agents/skills/shared/scripts/run.sh'), 'utf8')).toBe('echo hi');
    expect(readlinkSync(join(pcB, '.claude/skills/shared'))).toBe(
      join(pcB, '.agents/skills/shared'),
    );
    const [a] = await discoverLocalSkills({ home: pcA });
    const [b] = await discoverLocalSkills({ home: pcB });
    expect(b!.treeSha).toBe(a!.treeSha);

    expect(
      (await downloadHubSkill(client, 'shared', { home: pcB, maxBytes: 1 << 20 })).status,
    ).toBe('unchanged');
    writeFileSync(
      join(pcB, '.agents/skills/shared/SKILL.md'),
      '---\nname: shared\ndescription: edited\n---\n',
    );
    expect(
      (await downloadHubSkill(client, 'shared', { home: pcB, maxBytes: 1 << 20 })).status,
    ).toBe('skipped');
    expect(
      (
        await downloadHubSkill(
          client,
          'shared',
          { home: pcB, maxBytes: 1 << 20 },
          { overwrite: true },
        )
      ).status,
    ).toBe('replaced');
    expect(readFileSync(join(pcB, '.agents/skills/shared/SKILL.md'), 'utf8')).toMatch(
      /The shared skill/,
    );
  });

  it('never deletes a separate, different claude copy', async () => {
    const pcA = tmp('skpca2-');
    writeSkill(join(pcA, '.agents/skills'), 'shared');
    const { client } = fakeClient();
    await seedSkillsIfEmpty(client, { home: pcA, maxBytes: 1 << 20 });
    const pcB = tmp('skpcb2-');
    writeSkill(join(pcB, '.claude/skills'), 'shared', { 'mine.md': 'my edits' });
    const got = await downloadHubSkill(
      client,
      'shared',
      { home: pcB, maxBytes: 1 << 20 },
      { overwrite: true },
    );
    expect(got).toMatchObject({
      status: 'installed',
      kept: [join(pcB, '.claude/skills/shared')],
    });
    expect(readFileSync(join(pcB, '.claude/skills/shared/mine.md'), 'utf8')).toBe('my edits');
  });

  it('refuses a tarball whose files do not hash to the advertised version', async () => {
    const { client, store } = fakeClient();
    store.set('bad', {
      version: 'a'.repeat(64),
      data: writeTar([{ path: 'SKILL.md', mode: 0o644, data: Buffer.from('x') }]),
      meta: { description: 'd' },
    });
    await expect(
      downloadHubSkill(client, 'bad', { home: tmp('skbad-'), maxBytes: 1 << 20 }),
    ).rejects.toThrow(/hash to/);
  });
});

describe('seeded memo', () => {
  it('remembers hubs by normalized url, in the isolated HOME', async () => {
    expect(process.env.HOME).toContain('skills-lib-home-');
    await rememberSeeded('http://127.0.0.1:8790/');
    await rememberSeeded('https://hub.example.com');
    expect(await seededHubs()).toEqual(['http://127.0.0.1:8790', 'https://hub.example.com']);
  });
});
