import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The load-bearing back-compat proof for the agent status map.
 *
 * `agentbox-ctl` is BAKED INTO THE BOX IMAGE. A box created from a snapshot
 * taken before the map existed keeps posting the old `claude`/`codex`/`opencode`
 * blocks for as long as that box lives, and no host-side release can change
 * that — so the host has to keep reading them, forever, from a file that a
 * relay of any vintage may have written.
 *
 * The fixture below is a VERBATIM old-shape `status.json`. It must not be
 * "modernized" to make a test pass: the point is that it is what really sits on
 * disk for every box that predates this change.
 */
const LEGACY_STATUS_JSON = `{
  "schema": 1,
  "boxId": "abc123def456",
  "timestamp": "2026-08-01T12:00:00.000Z",
  "services": [{ "name": "web", "state": "ready", "port": 3000, "probed": true }],
  "tasks": [{ "name": "install", "state": "done" }],
  "ports": [{ "port": 3000, "service": "web" }],
  "claude": {
    "state": "end-plan",
    "updatedAt": "2026-08-01T11:59:00.000Z",
    "sessionRunning": true,
    "sessionTitle": "refactor the parser",
    "plan": { "plan": "# Step one", "capturedAt": "2026-08-01T11:59:00.000Z" }
  },
  "codex": {
    "state": "working",
    "updatedAt": "2026-08-01T11:58:00.000Z",
    "sessionRunning": true,
    "sessionTitle": "fixing tests"
  },
  "opencode": {
    "state": "waiting",
    "updatedAt": "2026-08-01T11:57:00.000Z",
    "sessionRunning": true
  }
}`;

// `@agentbox/config` resolves paths from `homedir()` at module load, so the fake
// home has to exist before the import below — hence hoisted + synchronous.
const home = mkdtempSync(join(tmpdir(), 'agentbox-status-'));

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});

const { readBoxStatus } = await import('../src/sync/host-export.js');

afterEach(async () => {
  await rm(join(home, '.agentbox'), { recursive: true, force: true });
});

async function writeStatus(body: string): Promise<{ id: string; name: string }> {
  const box = { id: 'abc123def456', name: 'smoke' };
  const dir = join(home, '.agentbox', 'boxes', `${box.id}-${box.name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'status.json'), body, 'utf8');
  return box;
}

describe('readBoxStatus — a status.json written before the agent map existed', () => {
  it('reconstructs the keyed map from the legacy named blocks', async () => {
    const box = await writeStatus(LEGACY_STATUS_JSON);
    const status = await readBoxStatus(box);

    expect(status).not.toBeNull();
    expect(Object.keys(status!.agents ?? {}).sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(status!.agents?.claude?.state).toBe('end-plan');
    expect(status!.agents?.claude?.sessionTitle).toBe('refactor the parser');
    expect(status!.agents?.claude?.plan?.plan).toBe('# Step one');
    expect(status!.agents?.codex?.state).toBe('working');
    // The one this change fixes: opencode's state was carried in the file all
    // along and dropped by the host's projection.
    expect(status!.agents?.opencode?.state).toBe('waiting');
  });

  it('leaves the legacy blocks in place, for readers that still want them', async () => {
    const box = await writeStatus(LEGACY_STATUS_JSON);
    const status = await readBoxStatus(box);
    expect(status!.claude?.state).toBe('end-plan');
    expect(status!.codex?.sessionTitle).toBe('fixing tests');
  });

  it('does not disturb the rest of the snapshot', async () => {
    const box = await writeStatus(LEGACY_STATUS_JSON);
    const status = await readBoxStatus(box);
    expect(status!.services).toEqual([{ name: 'web', state: 'ready', port: 3000, probed: true }]);
    expect(status!.tasks).toEqual([{ name: 'install', state: 'done' }]);
    expect(status!.ports).toEqual([{ port: 3000, service: 'web' }]);
    expect(status!.boxId).toBe('abc123def456');
  });

  it('reads a current snapshot, and prefers its map over the mirror', async () => {
    const box = await writeStatus(
      JSON.stringify({
        schema: 1,
        boxId: 'abc123def456',
        timestamp: '2026-08-30T12:00:00.000Z',
        services: [],
        tasks: [],
        ports: [],
        agents: { openclaw: { state: 'working', updatedAt: null, sessionRunning: true } },
        claude: { state: 'idle', updatedAt: null, sessionRunning: false },
      }),
    );
    const status = await readBoxStatus(box);
    expect(status!.agents?.openclaw?.state).toBe('working');
    expect(status!.agents?.claude?.state).toBe('idle');
  });

  it('still refuses a future-incompatible schema outright', async () => {
    const box = await writeStatus(JSON.stringify({ schema: 2, boxId: 'abc123def456' }));
    expect(await readBoxStatus(box)).toBeNull();
  });

  it('returns null rather than throwing on a torn or absent file', async () => {
    expect(await readBoxStatus({ id: 'nope', name: 'gone' })).toBeNull();
    const box = await writeStatus('{ "schema": 1, "boxId": "abc123def456"');
    expect(await readBoxStatus(box)).toBeNull();
  });
});
