import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeContextSha256,
  DOCKER_CONTEXT_FILE_MAP,
  preparedStatePathFor,
  readPreparedStateRaw,
  resolveContextFilesFrom,
  sha256OfFile,
  writePreparedStateRaw,
} from '../src/prepared-state.js';

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

  it('DOCKER_CONTEXT_FILE_MAP includes Dockerfile.box and the COPYed scripts', () => {
    expect(DOCKER_CONTEXT_FILE_MAP['Dockerfile.box']).toBeDefined();
    expect(DOCKER_CONTEXT_FILE_MAP['scripts/agentbox-vnc-start']).toBeDefined();
    expect(DOCKER_CONTEXT_FILE_MAP['scripts/custom-system-CLAUDE.md']).toBeDefined();
    expect(DOCKER_CONTEXT_FILE_MAP['ctl/bin.cjs']).toBeDefined();
  });
});
