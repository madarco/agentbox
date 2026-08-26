import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

// Redirect HOME before importing: the reap reads and writes the control box's
// own `~/.agentbox/state.json` and per-box key dirs. The sibling
// `remote-boxes.test.ts` has no isolation, so this lives in its own file.
const TEST_HOME = await mkdtemp(join(tmpdir(), 'agentbox-local-reap-'));
const REAL_HOME = process.env['HOME'];
process.env['HOME'] = TEST_HOME;

const { handleRemoteBoxesRequest } = await import('../src/remote-boxes.js');
const { SqliteStore } = await import('../src/store/sqlite-store.js');
const { boxSshDirForProvider } = await import('@agentbox/sandbox-core');

const ADMIN = 'admin-secret';
const STATE = join(TEST_HOME, '.agentbox', 'state.json');
const open: InstanceType<typeof SqliteStore>[] = [];

function store(): InstanceType<typeof SqliteStore> {
  const s = new SqliteStore({ path: ':memory:' });
  open.push(s);
  return s;
}

/** A cloud BoxRecord as the control box would have persisted it. */
function record(id: string, sandboxId: string) {
  return {
    id,
    name: id,
    provider: 'hetzner',
    container: `cloud:${sandboxId}`,
    image: 'agentbox-base',
    workspacePath: '/tmp/ws',
    createdAt: new Date(0).toISOString(),
    cloud: { backend: 'hetzner', sandboxId },
  };
}

async function writeState(records: ReturnType<typeof record>[]): Promise<void> {
  await mkdir(dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify({ version: 1, boxes: records }), 'utf8');
}

async function readBoxIds(): Promise<string[]> {
  const { readFile } = await import('node:fs/promises');
  const s = JSON.parse(await readFile(STATE, 'utf8')) as { boxes: { id: string }[] };
  return s.boxes.map((b) => b.id);
}

function del(boxId: string) {
  return { method: 'DELETE', path: `/remote/boxes/${boxId}`, bearer: ADMIN, bodyText: '' };
}

afterEach(async () => {
  await rm(join(TEST_HOME, '.agentbox'), { recursive: true, force: true });
});
afterAll(async () => {
  await Promise.all(open.map((s) => s.close()));
  process.env['HOME'] = REAL_HOME;
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe('DELETE reap — the control box’s own state', () => {
  // Reaping only the Store left the control box's local record behind, so a box
  // destroyed from the PC kept showing as `running` in `hub boxes list`, the
  // dashboard and the tray — with its private key still on disk.
  it('removes the local record and the per-box key dir', async () => {
    await writeState([record('box-1', '156411131'), record('box-2', '156409612')]);
    const sshDir = boxSshDirForProvider('hetzner', '156411131');
    expect(sshDir).not.toBeNull();
    await mkdir(sshDir!, { recursive: true });
    await writeFile(join(sshDir!, 'id_ed25519'), 'PRIVATE', { mode: 0o600 });

    const res = await handleRemoteBoxesRequest(del('box-1'), { store: store(), adminToken: ADMIN });

    expect(res?.status).toBe(200);
    expect((res?.body as { localRemoved: boolean }).localRemoved).toBe(true);
    expect(await readBoxIds()).toEqual(['box-2']);
    expect(existsSync(dirname(sshDir!))).toBe(false);
  });

  // Scoped to THIS box only — a sweep here would take a live box's key with it.
  it('leaves another live box’s key dir untouched', async () => {
    await writeState([record('box-1', '111'), record('box-2', '222')]);
    const mine = boxSshDirForProvider('hetzner', '111')!;
    const theirs = boxSshDirForProvider('hetzner', '222')!;
    await mkdir(mine, { recursive: true });
    await mkdir(theirs, { recursive: true });

    await handleRemoteBoxesRequest(del('box-1'), { store: store(), adminToken: ADMIN });

    expect(existsSync(dirname(mine))).toBe(false);
    expect(existsSync(dirname(theirs))).toBe(true);
  });

  it('still 404s when nothing anywhere knows the box', async () => {
    await writeState([record('box-2', '222')]);
    const res = await handleRemoteBoxesRequest(del('box-1'), { store: store(), adminToken: ADMIN });
    expect(res?.status).toBe(404);
  });

  // A plain relay (no state.json) must not fail the reap.
  it('is a no-op when there is no local state at all', async () => {
    const s = store();
    await s.registerBox({
      boxId: 'box-1',
      token: 't',
      name: 'box-1',
      registeredAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    const res = await handleRemoteBoxesRequest(del('box-1'), { store: s, adminToken: ADMIN });
    expect(res?.status).toBe(200);
    expect((res?.body as { localRemoved: boolean }).localRemoved).toBe(false);
  });
});
