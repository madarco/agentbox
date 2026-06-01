import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeClaudeProjectsKey,
  resolveClaudeMemoryDir,
  BOX_CLAUDE_PROJECT_DIR,
} from '../src/host-stage.js';
import {
  BOX_MEMORY_DIR,
  BOX_WORKFLOWS_DIR,
  buildHostSyncManifest,
  computeSyncDelta,
  stageDynamicSyncTarball,
  type DynamicSyncManifest,
  type HostSyncManifest,
} from '../src/dynamic-sync.js';

describe('encodeClaudeProjectsKey', () => {
  it('encodes /workspace to -workspace', () => {
    expect(encodeClaudeProjectsKey('/workspace')).toBe('-workspace');
  });
  it('replaces every non-alphanumeric char with a dash', () => {
    expect(encodeClaudeProjectsKey('/Users/marco/Projects/foo')).toBe('-Users-marco-Projects-foo');
  });
  it('keeps BOX_MEMORY_DIR aligned with the -workspace key', () => {
    expect(BOX_MEMORY_DIR).toBe(`${BOX_CLAUDE_PROJECT_DIR}/memory`);
  });
});

// Build a host manifest fixture without touching disk.
function hostManifest(
  workflows: Record<string, string>,
  memory: Record<string, string>,
  opts: { workflowsHostDir?: string | null; memoryHostDir?: string | null } = {},
): HostSyncManifest {
  return {
    sets: {
      workflows: {
        dst: BOX_WORKFLOWS_DIR,
        files: workflows,
        hostDir: opts.workflowsHostDir === undefined ? '/host/.claude/workflows' : opts.workflowsHostDir,
      },
      memory: {
        dst: BOX_MEMORY_DIR,
        files: memory,
        hostDir: opts.memoryHostDir === undefined ? '/host/mem' : opts.memoryHostDir,
      },
    },
  };
}

describe('computeSyncDelta', () => {
  it('uploads everything for a fresh box (no manifest)', () => {
    const host = hostManifest({ 'a.ts': 'h1', 'sub/b.ts': 'h2' }, { 'MEMORY.md': 'h3' });
    const delta = computeSyncDelta(host, null);
    expect(delta.uploads.map((u) => `${u.set}/${u.rel}`).sort()).toEqual([
      'memory/MEMORY.md',
      'workflows/a.ts',
      'workflows/sub/b.ts',
    ]);
    expect(delta.deletions).toEqual([]);
    // box-absolute destinations
    const dsts = Object.fromEntries(delta.uploads.map((u) => [`${u.set}/${u.rel}`, u.dst]));
    expect(dsts['workflows/sub/b.ts']).toBe(`${BOX_WORKFLOWS_DIR}/sub/b.ts`);
    expect(dsts['memory/MEMORY.md']).toBe(`${BOX_MEMORY_DIR}/MEMORY.md`);
    // absolute source paths derive from hostDir
    expect(delta.uploads.find((u) => u.rel === 'a.ts')?.absSrc).toBe('/host/.claude/workflows/a.ts');
  });

  it('is a no-op when hashes match', () => {
    const host = hostManifest({ 'a.ts': 'h1' }, { 'MEMORY.md': 'h3' });
    const box: DynamicSyncManifest = {
      version: 1,
      sets: {
        workflows: { dst: BOX_WORKFLOWS_DIR, files: { 'a.ts': 'h1' } },
        memory: { dst: BOX_MEMORY_DIR, files: { 'MEMORY.md': 'h3' } },
      },
    };
    const delta = computeSyncDelta(host, box);
    expect(delta.uploads).toEqual([]);
    expect(delta.deletions).toEqual([]);
  });

  it('uploads only the changed/new files', () => {
    const host = hostManifest({ 'a.ts': 'h1-new', 'c.ts': 'h4' }, { 'MEMORY.md': 'h3' });
    const box: DynamicSyncManifest = {
      version: 1,
      sets: {
        workflows: { dst: BOX_WORKFLOWS_DIR, files: { 'a.ts': 'h1', 'c.ts': 'h4' } },
        memory: { dst: BOX_MEMORY_DIR, files: { 'MEMORY.md': 'h3' } },
      },
    };
    const delta = computeSyncDelta(host, box);
    expect(delta.uploads.map((u) => `${u.set}/${u.rel}`)).toEqual(['workflows/a.ts']);
    expect(delta.deletions).toEqual([]);
  });

  it('deletes files removed on the host', () => {
    const host = hostManifest({ 'a.ts': 'h1' }, {}, { memoryHostDir: null });
    const box: DynamicSyncManifest = {
      version: 1,
      sets: {
        workflows: { dst: BOX_WORKFLOWS_DIR, files: { 'a.ts': 'h1', 'gone.ts': 'hx' } },
        memory: { dst: BOX_MEMORY_DIR, files: { 'old.md': 'hy' } },
      },
    };
    const delta = computeSyncDelta(host, box);
    expect(delta.uploads).toEqual([]);
    expect(delta.deletions.map((d) => d.dst).sort()).toEqual([
      `${BOX_MEMORY_DIR}/old.md`,
      `${BOX_WORKFLOWS_DIR}/gone.ts`,
    ]);
  });

  it('nextManifest mirrors the host file set', () => {
    const host = hostManifest({ 'a.ts': 'h1' }, { 'MEMORY.md': 'h3' });
    const delta = computeSyncDelta(host, null);
    expect(delta.nextManifest).toEqual({
      version: 1,
      sets: {
        workflows: { dst: BOX_WORKFLOWS_DIR, files: { 'a.ts': 'h1' } },
        memory: { dst: BOX_MEMORY_DIR, files: { 'MEMORY.md': 'h3' } },
      },
    });
  });
});

describe('buildHostSyncManifest + resolveClaudeMemoryDir (real fs)', () => {
  let home: string;
  const workspace = '/Users/x/proj';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentbox-dynsync-home-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('hashes workflows and rekeyed memory; null memory dir yields empty set', async () => {
    const wf = join(home, '.claude', 'workflows');
    await mkdir(join(wf, 'nested'), { recursive: true });
    await writeFile(join(wf, 'top.ts'), 'export const meta = {}');
    await writeFile(join(wf, 'nested', 'deep.md'), '# deep');

    const memDir = join(home, '.claude', 'projects', encodeClaudeProjectsKey(workspace), 'memory');
    await mkdir(memDir, { recursive: true });
    await writeFile(join(memDir, 'MEMORY.md'), '- index');

    expect(await resolveClaudeMemoryDir(workspace, home)).toBe(memDir);

    const m = await buildHostSyncManifest(workspace, home);
    expect(Object.keys(m.sets.workflows.files).sort()).toEqual(['nested/deep.md', 'top.ts']);
    expect(Object.keys(m.sets.memory.files)).toEqual(['MEMORY.md']);
    expect(m.sets.workflows.files['top.ts']).toMatch(/^[0-9a-f]{64}$/);
    expect(m.sets.workflows.dst).toBe(BOX_WORKFLOWS_DIR);
    expect(m.sets.memory.dst).toBe(BOX_MEMORY_DIR);
    // identical content hashes identically (idempotent)
    const m2 = await buildHostSyncManifest(workspace, home);
    expect(m2.sets.workflows.files['top.ts']).toBe(m.sets.workflows.files['top.ts']);
  });

  it('returns empty sets when host has neither workflows nor memory', async () => {
    expect(await resolveClaudeMemoryDir(workspace, home)).toBeNull();
    const m = await buildHostSyncManifest(workspace, home);
    expect(m.sets.workflows.files).toEqual({});
    expect(m.sets.memory.files).toEqual({});
  });

  it('treats an empty memory dir as absent', async () => {
    const memDir = join(home, '.claude', 'projects', encodeClaudeProjectsKey(workspace), 'memory');
    await mkdir(memDir, { recursive: true });
    expect(await resolveClaudeMemoryDir(workspace, home)).toBeNull();
  });
});

describe('stageDynamicSyncTarball', () => {
  it('returns a null tarball for an empty upload list', async () => {
    const staged = await stageDynamicSyncTarball([]);
    expect(staged.tarballPath).toBeNull();
    await staged.cleanup();
  });
});
