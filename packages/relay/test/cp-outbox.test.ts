import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  cpOutboxPrefix,
  isCpOutboxMetaPath,
  landCpOutboxTar,
  listCpOutbox,
  removeCpOutboxItem,
  stageOutboxTar,
  type CpOutboxMeta,
} from '../src/cp-outbox.js';
import { FsCustodyStore } from '../src/custody/fs-store.js';

const run = promisify(execFile);
import { existsSync } from 'node:fs';

describe('cp outbox', () => {
  let dir: string;
  let custody: FsCustodyStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-outbox-test-'));
    custody = new FsCustodyStore({ root: dir });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function park(id: string, boxId: string, createdAt: string): Promise<void> {
    const prefix = cpOutboxPrefix({ projectSlug: 'acme__web', boxId });
    const meta: CpOutboxMeta = {
      id,
      boxId,
      boxName: `box-${boxId}`,
      dest: './out/',
      sources: ['/workspace/report.txt'],
      createdAt,
      size: 10,
    };
    await custody.put(`${prefix}/${id}.tar`, Buffer.from('tar-bytes'));
    await custody.put(`${prefix}/${id}.json`, Buffer.from(JSON.stringify(meta)));
  }

  it('recognizes its own sidecars and nothing else', () => {
    expect(isCpOutboxMetaPath('projects/acme__web/cp-out/abc-123.json')).toBe(true);
    // The read cache lives next door and must not be drained as outbound work.
    expect(isCpOutboxMetaPath('projects/acme__web/cp/abc.json')).toBe(false);
    expect(isCpOutboxMetaPath('agents/claude/.credentials.json')).toBe(false);
    expect(isCpOutboxMetaPath('projects/acme__web/cp-out/abc-123.tar')).toBe(false);
  });

  it('lists parked copies newest first, with the tar beside each sidecar', async () => {
    await park('id-old', 'b1', '2026-08-27T10:00:00Z');
    await park('id-new', 'b1', '2026-08-27T12:00:00Z');
    const items = await listCpOutbox(custody);
    expect(items.map((i) => i.meta.id)).toEqual(['id-new', 'id-old']);
    expect(items[0]!.tarPath).toBe('projects/acme__web/cp-out/id-new.tar');
    expect(items[0]!.metaPath).toBe('projects/acme__web/cp-out/id-new.json');
  });

  it('ignores a corrupt sidecar instead of failing the whole drain', async () => {
    await park('good', 'b1', '2026-08-27T10:00:00Z');
    await custody.put('projects/acme__web/cp-out/broken.json', Buffer.from('{not json'));
    const items = await listCpOutbox(custody);
    expect(items.map((i) => i.meta.id)).toEqual(['good']);
  });

  it('removes both halves once landed, so it is not offered twice', async () => {
    await park('id-1', 'b1', '2026-08-27T10:00:00Z');
    const [item] = await listCpOutbox(custody);
    await removeCpOutboxItem(custody, item!);
    expect(await listCpOutbox(custody)).toHaveLength(0);
    expect(await custody.stat(item!.tarPath)).toBeNull();
    // Removing twice is a no-op, since a retry after a partial failure must work.
    await removeCpOutboxItem(custody, item!);
  });

  it('round-trips real bytes: stage a tar from a stream, then land it', async () => {
    const src = join(dir, 'src');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'report.txt'), 'agent output\n', 'utf8');
    const tarPath = join(dir, 'payload.tar');
    await run('tar', ['-cf', tarPath, '-C', src, 'report.txt']);

    const staged = await stageOutboxTar(createReadStream(tarPath));
    const dest = join(dir, 'landed', 'nested');
    // The destination directory does not exist yet — landing must create it,
    // since the user's target dir may have been removed since the copy was made.
    await landCpOutboxTar(staged.tarPath, dest, { destEndsWithSlash: true });
    expect(await readFile(join(dest, 'report.txt'), 'utf8')).toBe('agent output\n');
    await rm(staged.dir, { recursive: true, force: true });
  });

  it('honors a destination that NAMES the file, like `cp` does', async () => {
    // `cp toHost /workspace/report.txt ./out/summary.txt` must produce
    // summary.txt. Stripping the destination to its parent directory (the naive
    // version) silently kept the box's own filename instead.
    const src = join(dir, 'src2');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'report.txt'), 'renamed\n', 'utf8');
    const tarPath = join(dir, 'rename.tar');
    await run('tar', ['-cf', tarPath, '-C', src, 'report.txt']);
    const dest = join(dir, 'out', 'summary.txt');
    await landCpOutboxTar(tarPath, dest, { destEndsWithSlash: false });
    expect(await readFile(dest, 'utf8')).toBe('renamed\n');
    // ...and NOT under its original name beside it.
    expect(existsSync(join(dir, 'out', 'report.txt'))).toBe(false);
  });

  it('treats an existing directory as the destination even without a trailing slash', async () => {
    const src = join(dir, 'src3');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'report.txt'), 'into dir\n', 'utf8');
    const tarPath = join(dir, 'intodir.tar');
    await run('tar', ['-cf', tarPath, '-C', src, 'report.txt']);
    const dest = join(dir, 'existing');
    await mkdir(dest, { recursive: true });
    await landCpOutboxTar(tarPath, dest, { destEndsWithSlash: false });
    expect(await readFile(join(dest, 'report.txt'), 'utf8')).toBe('into dir\n');
  });

  it('leaves the destination intact when landing cannot complete', async () => {
    // Landing used to `rm` the destination and then rename from the system
    // tmpdir — a different filesystem in most setups, so the rename fails EXDEV
    // and the file the copy meant to update is simply gone. Staging beside the
    // destination makes the replace atomic; a corrupt payload must leave the
    // existing file untouched.
    const dest = join(dir, 'keep', 'existing.txt');
    await mkdir(join(dir, 'keep'), { recursive: true });
    await writeFile(dest, 'ORIGINAL\n', 'utf8');
    const bogus = join(dir, 'not-a.tar');
    await writeFile(bogus, 'this is not a tar archive', 'utf8');
    await expect(landCpOutboxTar(bogus, dest, { destEndsWithSlash: false })).rejects.toBeTruthy();
    expect(await readFile(dest, 'utf8')).toBe('ORIGINAL\n');
  });

  it('replaces an existing file at the destination', async () => {
    const src = join(dir, 'src4');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'report.txt'), 'NEW\n', 'utf8');
    const tarPath = join(dir, 'replace.tar');
    await run('tar', ['-cf', tarPath, '-C', src, 'report.txt']);
    const dest = join(dir, 'replace', 'target.txt');
    await mkdir(join(dir, 'replace'), { recursive: true });
    await writeFile(dest, 'OLD\n', 'utf8');
    await landCpOutboxTar(tarPath, dest, { destEndsWithSlash: false });
    expect(await readFile(dest, 'utf8')).toBe('NEW\n');
  });

  it('keys the outbox per project, falling back to the box', () => {
    expect(cpOutboxPrefix({ projectSlug: 'acme__web', boxId: 'b1' })).toBe(
      'projects/acme__web/cp-out',
    );
    expect(cpOutboxPrefix({ boxId: 'b1' })).toBe('boxes/b1/cp-out');
  });
});
