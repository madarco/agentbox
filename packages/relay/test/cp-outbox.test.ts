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
    await landCpOutboxTar(staged.tarPath, dest);
    expect(await readFile(join(dest, 'report.txt'), 'utf8')).toBe('agent output\n');
    await rm(staged.dir, { recursive: true, force: true });
  });

  it('keys the outbox per project, falling back to the box', () => {
    expect(cpOutboxPrefix({ projectSlug: 'acme__web', boxId: 'b1' })).toBe(
      'projects/acme__web/cp-out',
    );
    expect(cpOutboxPrefix({ boxId: 'b1' })).toBe('boxes/b1/cp-out');
  });
});
