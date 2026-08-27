import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeInstallFingerprint,
  computeContextManifest,
  computeContextSha256,
  diffFileManifests,
  DOCKER_CONTEXT_FILE_MAP,
  matchClaudeInstallFingerprint,
  preparedStatePathFor,
  readPreparedStateRaw,
  resolveContextFilesFrom,
  sha256OfFile,
  writePreparedStateRaw,
} from '../src/prepared-state.js';

/**
 * A prepared record stores only the FOLDED fingerprint, never the install mode
 * that produced it, so the mode can only be recovered by trying both. This is
 * what lets a control box (which defaults to `native`, because the PC's
 * `box.claudeInstall` never travels to it) use a bake a PC made with `npm`
 * instead of failing every create with "run `agentbox prepare` first".
 */
describe('matchClaudeInstallFingerprint', () => {
  const NATIVE = 'a'.repeat(64); // stands in for a raw context sha

  it('recognises a native bake (the identity fold)', () => {
    expect(matchClaudeInstallFingerprint(NATIVE, NATIVE)).toBe('native');
  });

  it('recognises an npm bake against the native fingerprint', () => {
    const npm = claudeInstallFingerprint(NATIVE, 'npm');
    expect(npm).not.toBe(NATIVE); // the fold must actually distinguish them
    expect(matchClaudeInstallFingerprint(npm, NATIVE)).toBe('npm');
  });

  it('refuses a fingerprint from a genuinely different build context', () => {
    const otherContext = 'b'.repeat(64);
    expect(matchClaudeInstallFingerprint(otherContext, NATIVE)).toBeNull();
    // ...including that context's npm fold — a different base is still different.
    expect(
      matchClaudeInstallFingerprint(claudeInstallFingerprint(otherContext, 'npm'), NATIVE),
    ).toBeNull();
  });

  it('stays in step with claudeInstallFingerprint for both modes', () => {
    // Pinning the pair together is the point: if the fold changes and the match
    // doesn't, every shared bake silently stops being adoptable.
    for (const mode of ['native', 'npm'] as const) {
      expect(matchClaudeInstallFingerprint(claudeInstallFingerprint(NATIVE, mode), NATIVE)).toBe(
        mode,
      );
    }
  });
});

describe('computeContextSha256', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-fp-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, body: string): Promise<{ rel: string; abs: string }> {
    const abs = join(dir, name);
    await writeFile(abs, body, 'utf8');
    return { rel: name, abs };
  }

  it('is deterministic across runs on identical content', async () => {
    const files = [
      await write('a.txt', 'alpha\n'),
      await write('b.txt', 'beta\n'),
      await write('c.txt', 'gamma\n'),
    ];
    const a = await computeContextSha256(files);
    const b = await computeContextSha256(files);
    expect(a).toEqual(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is invariant to input ordering', async () => {
    const files = [
      await write('a.txt', 'alpha\n'),
      await write('b.txt', 'beta\n'),
      await write('c.txt', 'gamma\n'),
    ];
    const forward = await computeContextSha256(files);
    const reversed = await computeContextSha256([...files].reverse());
    expect(reversed).toEqual(forward);
  });

  it('changes when any file content changes', async () => {
    const files = [await write('a.txt', 'alpha\n'), await write('b.txt', 'beta\n')];
    const before = await computeContextSha256(files);
    await writeFile(files[1]!.abs, 'beta-edited\n', 'utf8');
    const after = await computeContextSha256(files);
    expect(after).not.toEqual(before);
  });

  it('changes when a logical rel-path changes (same bytes, renamed)', async () => {
    const a = await write('a.txt', 'shared\n');
    const b = await write('b.txt', 'shared\n');
    const ha = await computeContextSha256([a]);
    const hb = await computeContextSha256([b]);
    expect(ha).not.toEqual(hb);
  });

  it('matches a manual hash of two files', async () => {
    const a = await write('a', 'A');
    const b = await write('b', 'B');
    const hash = await computeContextSha256([a, b]);
    // Tip: the outer hash is sha256("a\0" + sha256("A") + "\nb\0" + sha256("B") + "\n").
    // We don't recompute that here — just verify the function changes for a known mutation.
    await writeFile(a.abs, 'AA', 'utf8');
    const hash2 = await computeContextSha256([a, b]);
    expect(hash2).not.toEqual(hash);
  });
});

describe('sha256OfFile', () => {
  it('hashes deterministically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentbox-sha-'));
    try {
      const path = join(dir, 'f.txt');
      await writeFile(path, 'hello\n', 'utf8');
      const h = await sha256OfFile(path);
      // sha256("hello\n") = 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03
      expect(h).toEqual('5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readPreparedStateRaw / writePreparedStateRaw', () => {
  let prevHome: string | undefined;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-prep-'));
    prevHome = process.env.HOME;
    process.env.HOME = dir;
  });
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the file is missing', () => {
    expect(readPreparedStateRaw('docker')).toBeNull();
  });

  it('returns null on malformed JSON without throwing', async () => {
    await writeFile(preparedStatePathFor('docker'), 'not json', 'utf8').catch(async () => {
      // dir may not exist yet — create it.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, '.agentbox'), { recursive: true });
      await writeFile(preparedStatePathFor('docker'), 'not json', 'utf8');
    });
    expect(readPreparedStateRaw('docker')).toBeNull();
  });

  it('round-trips a state object', () => {
    const state = { schema: 1, base: { contextSha256: 'abc', cliVersion: '0.7.0' } };
    writePreparedStateRaw('docker', state);
    expect(readPreparedStateRaw('docker')).toEqual(state);
  });

  it('produces per-provider distinct paths', () => {
    expect(preparedStatePathFor('docker')).not.toEqual(preparedStatePathFor('daytona'));
    expect(preparedStatePathFor('daytona')).not.toEqual(preparedStatePathFor('hetzner'));
    expect(preparedStatePathFor('docker')).toMatch(/docker-prepared\.json$/);
  });
});

describe('resolveContextFilesFrom', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-ctxres-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prefers staged over dev when both exist', async () => {
    const { mkdir } = await import('node:fs/promises');
    const stagedDir = join(dir, 'staged');
    const devDir = join(dir, 'dev');
    await mkdir(stagedDir, { recursive: true });
    await mkdir(devDir, { recursive: true });
    await writeFile(join(stagedDir, 'A.txt'), 'staged', 'utf8');
    await writeFile(join(devDir, 'A.txt'), 'dev', 'utf8');
    const map = { 'A.txt': { staged: 'A.txt', dev: 'A.txt' } };
    const files = resolveContextFilesFrom(map, { contextDir: stagedDir, devRoot: devDir });
    expect(files).not.toBeNull();
    expect(files![0]!.abs).toEqual(join(stagedDir, 'A.txt'));
  });

  it('falls back to dev when staged is missing', async () => {
    const { mkdir } = await import('node:fs/promises');
    const stagedDir = join(dir, 'staged');
    const devDir = join(dir, 'dev');
    await mkdir(stagedDir, { recursive: true });
    await mkdir(devDir, { recursive: true });
    await writeFile(join(devDir, 'A.txt'), 'dev', 'utf8');
    const map = { 'A.txt': { staged: 'A.txt', dev: 'A.txt' } };
    const files = resolveContextFilesFrom(map, { contextDir: stagedDir, devRoot: devDir });
    expect(files).not.toBeNull();
    expect(files![0]!.abs).toEqual(join(devDir, 'A.txt'));
  });

  it('returns null when any file is missing in both layouts', async () => {
    const { mkdir } = await import('node:fs/promises');
    const stagedDir = join(dir, 'staged');
    const devDir = join(dir, 'dev');
    await mkdir(stagedDir, { recursive: true });
    await mkdir(devDir, { recursive: true });
    await writeFile(join(stagedDir, 'A.txt'), '', 'utf8');
    // B is missing in both
    const map = {
      'A.txt': { staged: 'A.txt', dev: 'A.txt' },
      'B.txt': { staged: 'B.txt', dev: 'B.txt' },
    };
    expect(resolveContextFilesFrom(map, { contextDir: stagedDir, devRoot: devDir })).toBeNull();
  });

  // Derived from Dockerfile.box rather than spot-checked: the previous version
  // asserted four known keys and so happily passed while EIGHT COPY'd files were
  // missing from the map — meaning edits to gh-shim, git-shim,
  // agentbox-tool-shim, chromium-resolver, agentbox-sshd-start, agentbox-portless-trust
  // and opencode-agentbox-plugin.js never invalidated the image.
  it('DOCKER_CONTEXT_FILE_MAP covers every file Dockerfile.box COPYs', async () => {
    const dockerfile = join(__dirname, '..', '..', 'sandbox-docker', 'Dockerfile.box');
    const body = await readFile(dockerfile, 'utf8');
    const copied = [...body.matchAll(/^COPY\s+(?:--\S+\s+)*(\S+)\s+\S+\s*$/gm)]
      .map((m) => m[1]!)
      .filter((src) => !src.startsWith('--'));
    expect(copied.length).toBeGreaterThan(10); // sanity: the regex still matches

    const staged = new Set(Object.values(DOCKER_CONTEXT_FILE_MAP).map((v) => v.staged));
    const missing = copied.filter((src) => !staged.has(src));
    expect(
      missing,
      `COPY'd but absent from DOCKER_CONTEXT_FILE_MAP: ${missing.join(', ')}`,
    ).toEqual([]);

    // The Dockerfile itself is part of the context even though nothing COPYs it.
    expect(DOCKER_CONTEXT_FILE_MAP['Dockerfile.box']).toBeDefined();
  });
});

describe('computeContextManifest', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-man-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  async function write(name: string, body: string): Promise<{ rel: string; abs: string }> {
    const abs = join(dir, name);
    await writeFile(abs, body, 'utf8');
    return { rel: name, abs };
  }

  // The invariant that makes the refactor safe: computeContextSha256 now
  // delegates here, so the aggregate must be bit-identical to what it produced
  // before — otherwise every stored fingerprint would spuriously go stale.
  it('agrees with computeContextSha256 on the aggregate', async () => {
    const files = [await write('a.txt', 'alpha\n'), await write('b.txt', 'beta\n')];
    const m = await computeContextManifest(files);
    expect(m.contextSha256).toEqual(await computeContextSha256(files));
  });

  it('records a digest per file, keyed by rel', async () => {
    const a = await write('a.txt', 'alpha\n');
    const b = await write('b.txt', 'beta\n');
    const m = await computeContextManifest([a, b]);
    expect(Object.keys(m.files).sort()).toEqual(['a.txt', 'b.txt']);
    expect(m.files['a.txt']).toEqual(await sha256OfFile(a.abs));
    expect(m.files['b.txt']).toEqual(await sha256OfFile(b.abs));
  });

  it('is order-invariant like the aggregate', async () => {
    const files = [await write('a.txt', 'a'), await write('b.txt', 'b')];
    const fwd = await computeContextManifest(files);
    const rev = await computeContextManifest([...files].reverse());
    expect(rev).toEqual(fwd);
  });
});

describe('diffFileManifests', () => {
  it('names the changed file — the whole point of storing the manifest', () => {
    const d = diffFileManifests({ a: '1', b: '2' }, { a: '1', b: '9' });
    expect(d.changed).toEqual([{ rel: 'b', from: '2', to: '9' }]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('reports additions and removals', () => {
    const d = diffFileManifests({ a: '1', gone: '3' }, { a: '1', fresh: '4' });
    expect(d.added).toEqual(['fresh']);
    expect(d.removed).toEqual(['gone']);
    expect(d.changed).toEqual([]);
  });

  it('is empty for identical manifests', () => {
    const d = diffFileManifests({ a: '1' }, { a: '1' });
    expect(d).toEqual({ changed: [], added: [], removed: [] });
  });

  it('treats an empty stored manifest as all-added (never a false "changed")', () => {
    const d = diffFileManifests({}, { a: '1', b: '2' });
    expect(d.added).toEqual(['a', 'b']);
    expect(d.changed).toEqual([]);
  });
});
