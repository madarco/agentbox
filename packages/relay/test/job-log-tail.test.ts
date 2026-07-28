import { mkdtempSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// STATE_DIR is `homedir()/.agentbox`, resolved when the module is first imported
// — so HOME must be redirected BEFORE the import (forks pool → per-file HOME).
const HOME = mkdtempSync(join(tmpdir(), 'agentbox-job-log-'));
process.env.HOME = HOME;
const LOGS = join(HOME, '.agentbox', 'logs');

let readCreateJobLog: (typeof import('../src/job-log-tail.js'))['readCreateJobLog'];
let isSafeJobId: (typeof import('../src/job-log-tail.js'))['isSafeJobId'];

beforeAll(async () => {
  ({ readCreateJobLog, isSafeJobId } = await import('../src/job-log-tail.js'));
  await mkdir(LOGS, { recursive: true });
});

describe('readCreateJobLog', () => {
  it('returns nothing for a job that has not logged yet', async () => {
    expect(await readCreateJobLog('never-ran', 0)).toEqual({ lines: [], offset: 0 });
  });

  it('reads whole lines and advances the offset', async () => {
    const path = join(LOGS, 'queue-job-a.log');
    await writeFile(path, 'cloning repo\nseeding files\n');
    const first = await readCreateJobLog('job-a', 0);
    expect(first.lines).toEqual(['cloning repo', 'seeding files']);
    expect(first.offset).toBe(27);

    // Nothing new yet.
    expect(await readCreateJobLog('job-a', first.offset)).toEqual({ lines: [], offset: 27 });

    await appendFile(path, 'created box b-1\n');
    const second = await readCreateJobLog('job-a', first.offset);
    expect(second.lines).toEqual(['created box b-1']);
    expect(second.offset).toBe(43);
  });

  it('holds back a partial trailing line until it is complete', async () => {
    const path = join(LOGS, 'queue-job-b.log');
    await writeFile(path, 'provisioning');
    const partial = await readCreateJobLog('job-b', 0);
    expect(partial).toEqual({ lines: [], offset: 0 });

    await appendFile(path, ' e2b box\n');
    const whole = await readCreateJobLog('job-b', 0);
    expect(whole.lines).toEqual(['provisioning e2b box']);
  });

  it('restarts from the top when the file shrank (rotated/truncated)', async () => {
    const path = join(LOGS, 'queue-job-c.log');
    await writeFile(path, 'fresh line\n');
    const tail = await readCreateJobLog('job-c', 9_999);
    expect(tail.lines).toEqual(['fresh line']);
  });

  it('refuses a job id that is not a bare token (path traversal)', async () => {
    expect(isSafeJobId('7f3c-42')).toBe(true);
    expect(isSafeJobId('../../etc/passwd')).toBe(false);
    expect(isSafeJobId('')).toBe(false);
    expect(await readCreateJobLog('../../etc/passwd', 0)).toEqual({ lines: [], offset: 0 });
  });
});
