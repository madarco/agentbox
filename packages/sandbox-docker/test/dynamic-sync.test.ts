import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeClaudeProjectsKey } from '@agentbox/sandbox-core';
import {
  BOX_WORKFLOWS_DIR,
  buildHostSyncManifest,
  computeSyncDelta,
  stageDynamicSyncTarball,
  type DynamicSyncManifest,
  type HostSyncManifest,
} from '../src/sync/dynamic-sync.js';

describe('encodeClaudeProjectsKey', () => {
  it('encodes /workspace to -workspace', () => {
    expect(encodeClaudeProjectsKey('/workspace')).toBe('-workspace');
  });
  it('replaces every non-alphanumeric char with a dash', () => {
    expect(encodeClaudeProjectsKey('/Users/marco/Projects/foo')).toBe('-Users-marco-Projects-foo');
  });
});

// Build a host manifest fixture without touching disk.
function hostManifest(
  workflows: Record<string, string>,
  opts: { workflowsHostDir?: string | null } = {},
): HostSyncManifest {
  return {
    sets: {
      workflows: {
        dst: BOX_WORKFLOWS_DIR,
        files: workflows,
        hostDir:
          opts.workflowsHostDir === undefined ? '/host/.claude/workflows' : opts.workflowsHostDir,
      },
    },
  };
}

describe('computeSyncDelta', () => {
  it('uploads everything for a fresh box (no manifest)', () => {
    const host = hostManifest({ 'a.ts': 'h1', 'sub/b.ts': 'h2' });
    const delta = computeSyncDelta(host, null);
    expect(delta.uploads.map((u) => `${u.set}/${u.rel}`).sort()).toEqual([
      'workflows/a.ts',
      'workflows/sub/b.ts',
    ]);
    const dsts = Object.fromEntries(delta.uploads.map((u) => [`${u.set}/${u.rel}`, u.dst]));
    expect(dsts['workflows/sub/b.ts']).toBe(`${BOX_WORKFLOWS_DIR}/sub/b.ts`);
    expect(delta.deletions).toEqual([]);
  });

  it('is a no-op when hashes match', () => {
    const host = hostManifest({ 'a.ts': 'h1' });
    const box: DynamicSyncManifest = {
      version: 1,
      sets: { workflows: { dst: BOX_WORKFLOWS_DIR, files: { 'a.ts': 'h1' } } },
    };
    const delta = computeSyncDelta(host, box);
    expect(delta.uploads).toEqual([]);
    expect(delta.deletions).toEqual([]);
  });

  it('uploads only the changed/new files', () => {
    const host = hostManifest({ 'a.ts': 'h1-changed', 'new.ts': 'hn' });
    const box: DynamicSyncManifest = {
      version: 1,
      sets: { workflows: { dst: BOX_WORKFLOWS_DIR, files: { 'a.ts': 'h1' } } },
    };
    const delta = computeSyncDelta(host, box);
    expect(delta.uploads.map((u) => u.rel).sort()).toEqual(['a.ts', 'new.ts']);
  });

  it('deletes files removed on the host', () => {
    const host = hostManifest({ 'a.ts': 'h1' });
    const box: DynamicSyncManifest = {
      version: 1,
      sets: { workflows: { dst: BOX_WORKFLOWS_DIR, files: { 'a.ts': 'h1', 'gone.ts': 'hx' } } },
    };
    const delta = computeSyncDelta(host, box);
    expect(delta.deletions.map((d) => d.dst)).toEqual([`${BOX_WORKFLOWS_DIR}/gone.ts`]);
  });

  it('ignores the memory set an older box manifest still carries', () => {
    const host = hostManifest({ 'a.ts': 'h1' });
    const box = {
      version: 1,
      sets: {
        workflows: { dst: BOX_WORKFLOWS_DIR, files: { 'a.ts': 'h1' } },
        memory: { dst: '/home/vscode/.claude/projects/-workspace/memory', files: { 'x.md': 'h' } },
      },
    } as unknown as DynamicSyncManifest;
    const delta = computeSyncDelta(host, box);
    expect(delta.uploads).toEqual([]);
    expect(delta.deletions).toEqual([]);
    expect(Object.keys(delta.nextManifest.sets)).toEqual(['workflows']);
  });

  it('nextManifest mirrors the host file set', () => {
    const host = hostManifest({ 'a.ts': 'h1' });
    const delta = computeSyncDelta(host, null);
    expect(delta.nextManifest.sets.workflows.files).toEqual({ 'a.ts': 'h1' });
  });
});

describe('buildHostSyncManifest (real fs)', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentbox-dynsync-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('hashes workflows', async () => {
    const wf = join(home, '.claude', 'workflows');
    await mkdir(join(wf, 'nested'), { recursive: true });
    await writeFile(join(wf, 'top.ts'), 'export const meta = {}');
    await writeFile(join(wf, 'nested', 'deep.md'), '# deep');

    const m = await buildHostSyncManifest(home);
    expect(Object.keys(m.sets.workflows.files).sort()).toEqual(['nested/deep.md', 'top.ts']);
    expect(m.sets.workflows.files['top.ts']).toMatch(/^[0-9a-f]{64}$/);
    expect(m.sets.workflows.dst).toBe(BOX_WORKFLOWS_DIR);
    // identical content hashes identically (idempotent)
    const m2 = await buildHostSyncManifest(home);
    expect(m2.sets.workflows.files['top.ts']).toBe(m.sets.workflows.files['top.ts']);
  });

  it('returns an empty set when the host has no workflows', async () => {
    const m = await buildHostSyncManifest(home);
    expect(m.sets.workflows.files).toEqual({});
  });
});

describe('stageDynamicSyncTarball', () => {
  it('returns a null tarball for an empty upload list', async () => {
    const staged = await stageDynamicSyncTarball([]);
    expect(staged.tarballPath).toBeNull();
    await staged.cleanup();
  });
});
