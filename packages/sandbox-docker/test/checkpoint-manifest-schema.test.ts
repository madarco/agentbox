// ESM static imports are hoisted, so a `process.env.HOME = ...` in this file
// body would run AFTER checkpoint.ts (which captures `homedir()` at module
// load via `CHECKPOINTS_ROOT`). Pre-set HOME in a vitest globalSetup-style
// constant assigned at the very top, then load checkpoint.ts *dynamically*
// inside each test — by then HOME is the temp dir.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-ckpt-mf-'));
process.env.HOME = TEST_HOME;
// `os.homedir()` on darwin honours USERPROFILE on Windows and HOME on POSIX;
// vitest doesn't override USERPROFILE so HOME alone is sufficient on CI.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { projectDirSegment } from '@agentbox/config';

async function writeManifest(
  projectRoot: string,
  name: string,
  manifest: Record<string, unknown> & { schema: number },
): Promise<void> {
  const segment = projectDirSegment(projectRoot);
  const dir = join(TEST_HOME, '.agentbox', 'checkpoints', segment, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

describe('checkpoint manifest schema', () => {
  afterAll(async () => {
    await rm(TEST_HOME, { recursive: true, force: true });
  });

  it('reads a schema-3 manifest with baseFingerprint + cliVersion', async () => {
    const { resolveCheckpoint } = await import('../src/checkpoint.js');
    const projectRoot = '/tmp/projA-' + Date.now().toString(36);
    await writeManifest(projectRoot, 'cp1', {
      schema: 3,
      name: 'cp1',
      type: 'layered',
      image: 'agentbox-ckpt-aaaa:cp1',
      parents: [],
      base: 'workspace',
      sourceBoxId: 'box1',
      sourceBoxName: 'demo',
      baseProvider: 'docker',
      baseFingerprint: 'abc123def456',
      cliVersion: '0.7.0',
      createdAt: '2026-05-26T00:00:00.000Z',
    });
    const got = await resolveCheckpoint(projectRoot, 'cp1');
    expect(got).not.toBeNull();
    expect(got!.manifest.schema).toBe(3);
    expect(got!.manifest.baseFingerprint).toBe('abc123def456');
    expect(got!.manifest.cliVersion).toBe('0.7.0');
    expect(got!.manifest.baseProvider).toBe('docker');
  });

  it('reads a schema-2 manifest gracefully (no fingerprint)', async () => {
    const { resolveCheckpoint } = await import('../src/checkpoint.js');
    const projectRoot = '/tmp/projB-' + Date.now().toString(36);
    await writeManifest(projectRoot, 'legacy', {
      schema: 2,
      name: 'legacy',
      type: 'flattened',
      image: 'agentbox-ckpt-bbbb:legacy',
      parents: [],
      base: 'workspace',
      sourceBoxId: 'box2',
      sourceBoxName: 'legacy-box',
      createdAt: '2025-12-01T00:00:00.000Z',
    });
    const got = await resolveCheckpoint(projectRoot, 'legacy');
    expect(got).not.toBeNull();
    expect(got!.manifest.schema).toBe(2);
    expect(got!.manifest.baseFingerprint).toBeUndefined();
    expect(got!.manifest.cliVersion).toBeUndefined();
  });

  it('returns null for an unknown schema (treated as unreadable)', async () => {
    const { resolveCheckpoint } = await import('../src/checkpoint.js');
    const projectRoot = '/tmp/projC-' + Date.now().toString(36);
    await writeManifest(projectRoot, 'future', {
      schema: 99,
      name: 'future',
      type: 'layered',
      image: 'x',
      parents: [],
      base: 'workspace',
      sourceBoxId: 'b',
      sourceBoxName: 'b',
      createdAt: '2030-01-01T00:00:00.000Z',
    });
    const got = await resolveCheckpoint(projectRoot, 'future');
    expect(got).toBeNull();
  });

  it('carries the agent set the box was captured from', async () => {
    const { resolveCheckpoint } = await import('../src/checkpoint.js');
    const projectRoot = '/tmp/projAgents-' + Date.now().toString(36);
    await writeManifest(projectRoot, 'cp-agents', {
      schema: 3,
      name: 'cp-agents',
      type: 'layered',
      image: 'agentbox-ckpt-bbbb:cp-agents',
      parents: [],
      base: 'workspace',
      sourceBoxId: 'box1',
      sourceBoxName: 'demo',
      baseProvider: 'docker',
      baseFingerprint: 'abc123def456',
      cliVersion: '0.29.0',
      agents: ['claude'],
      createdAt: '2026-08-29T00:00:00.000Z',
    });
    const got = await resolveCheckpoint(projectRoot, 'cp-agents');
    expect(got!.manifest.agents).toEqual(['claude']);
  });

  it('still reads a schema-3 manifest with NO agents field', async () => {
    // The reason the schema was NOT bumped for `agents`: every existing
    // checkpoint lacks the field and must keep loading unchanged. A bump would
    // have made them all vanish from `agentbox checkpoints` instead.
    const { resolveCheckpoint } = await import('../src/checkpoint.js');
    const projectRoot = '/tmp/projNoAgents-' + Date.now().toString(36);
    await writeManifest(projectRoot, 'cp-legacy', {
      schema: 3,
      name: 'cp-legacy',
      type: 'layered',
      image: 'agentbox-ckpt-cccc:cp-legacy',
      parents: [],
      base: 'workspace',
      sourceBoxId: 'box1',
      sourceBoxName: 'demo',
      baseProvider: 'docker',
      baseFingerprint: 'abc123def456',
      createdAt: '2026-05-26T00:00:00.000Z',
    });
    const got = await resolveCheckpoint(projectRoot, 'cp-legacy');
    expect(got).not.toBeNull();
    expect(got!.manifest.agents).toBeUndefined();
  });

  it('an unknown future field does not make a manifest unreadable', async () => {
    // Guards the forward-compat assumption the no-bump decision rests on.
    const { resolveCheckpoint } = await import('../src/checkpoint.js');
    const projectRoot = '/tmp/projFuture-' + Date.now().toString(36);
    await writeManifest(projectRoot, 'cp-future', {
      schema: 3,
      name: 'cp-future',
      type: 'layered',
      image: 'agentbox-ckpt-dddd:cp-future',
      parents: [],
      base: 'workspace',
      sourceBoxId: 'box1',
      sourceBoxName: 'demo',
      baseProvider: 'docker',
      baseFingerprint: 'abc123def456',
      somethingFromTheFuture: { nested: true },
      createdAt: '2026-05-26T00:00:00.000Z',
    } as never);
    const got = await resolveCheckpoint(projectRoot, 'cp-future');
    expect(got).not.toBeNull();
  });
});
