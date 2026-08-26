import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Guards the `prepare --name` (Daytona snapshot name) contract end of the plumbing:
// the CLI flag (commands/prepare.ts) → HubApiClient.prepareProvider body →
// parseProviderPrepare → hub-backend → enqueuePrepareJob → QueueJobPrepare. This
// asserts the LAST hop — that `name` actually lands on the persisted job manifest —
// since a Daytona bake can't run in a unit test. QUEUE_DIR is derived from HOME at
// import time, so HOME is set BEFORE the (dynamic) import of queue.ts and the file
// runs in relay's per-file fork isolation.
describe('enqueuePrepareJob threads the daytona --name into QueueJobPrepare', () => {
  let home: string;
  let mod: typeof import('../src/queue.js');
  const prevHome = process.env.HOME;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentbox-queue-name-'));
    process.env.HOME = home;
    mod = await import('../src/queue.js');
  });

  afterAll(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('writes prepare.name to the job manifest, and reads it back', async () => {
    const { job } = await mod.enqueuePrepareJob({
      providerName: 'daytona',
      name: 'agentbox-base-custom',
    });
    expect(job.kind).toBe('prepare');
    expect(job.prepare?.name).toBe('agentbox-base-custom');
    // Round-trip through the on-disk manifest — the shape the worker actually reads.
    const readBack = await mod.readJob(job.id);
    expect(readBack?.prepare?.name).toBe('agentbox-base-custom');
  });

  it('omits name when the flag is absent (the worker fills the default)', async () => {
    const { job } = await mod.enqueuePrepareJob({ providerName: 'daytona' });
    expect(job.prepare?.name).toBeUndefined();
  });
});
