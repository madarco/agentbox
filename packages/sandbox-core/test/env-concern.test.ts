import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSyncContext } from '../src/sync/context.js';
import { makeRecordingTransport } from '../src/sync/recording-transport.js';
import { DEFAULT_ENV_PATTERNS, pushEnvFiles, scanHostEnvFiles } from '../src/sync/concerns/env.js';

describe('env concern', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-env-concern-'));
    await writeFile(join(dir, '.env'), 'A=1');
    await writeFile(join(dir, '.env.local'), 'B=2');
    await mkdir(join(dir, 'apps', 'web'), { recursive: true });
    await writeFile(join(dir, 'apps', 'web', '.env.local'), 'X=1');
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', '.env'), 'leak=1'); // pruned
    await writeFile(join(dir, 'README.md'), 'unrelated');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('pushEnvFiles emits exactly one applyTarball into /workspace at uid 1000', async () => {
    const ctx = makeSyncContext({ boxName: 'b', boxId: 'b', provider: 'docker', hostWorkspace: dir });
    const t = makeRecordingTransport();
    const res = await pushEnvFiles(ctx, t, DEFAULT_ENV_PATTERNS);

    expect(res.copied).toBe(3); // .env, .env.local, apps/web/.env.local; node_modules pruned
    const applies = t.ops.filter((o) => o.op === 'applyTarball');
    expect(applies).toHaveLength(1);
    expect(applies[0]!.args.boxDestDir).toBe('/workspace');
    expect(applies[0]!.args.opts).toEqual({ uid: 1000 });
  });

  it('honors a custom boxWorkspace (cloud provider passes /workspace explicitly)', async () => {
    const ctx = makeSyncContext({
      boxName: 'b',
      boxId: 'b',
      provider: 'cloud',
      hostWorkspace: dir,
      boxWorkspace: '/ws',
    });
    const t = makeRecordingTransport({ withVolumes: false });
    await pushEnvFiles(ctx, t, DEFAULT_ENV_PATTERNS);
    expect(t.ops.filter((o) => o.op === 'applyTarball')[0]!.args.boxDestDir).toBe('/ws');
  });

  it('no matches → copied 0, no transport calls', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'agentbox-env-empty-'));
    try {
      const ctx = makeSyncContext({ boxName: 'b', boxId: 'b', provider: 'docker', hostWorkspace: empty });
      const t = makeRecordingTransport();
      const res = await pushEnvFiles(ctx, t, DEFAULT_ENV_PATTERNS);
      expect(res.copied).toBe(0);
      expect(t.ops).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('scanHostEnvFiles returns prefix-stripped paths (wizard preview form)', async () => {
    const out = await scanHostEnvFiles(dir, DEFAULT_ENV_PATTERNS);
    expect(out.sort()).toEqual(['.env', '.env.local', 'apps/web/.env.local']);
    expect(out.every((p) => !p.startsWith('./'))).toBe(true);
  });
});
