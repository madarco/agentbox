import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutReportFromScan, createCheckoutBackend } from '../lib/backend/checkouts';

const A = '0b9d6c3e-5f0a-4c1e-9d2b-7a8e6f4c3b21';
const B = '1c8e7d4f-6a1b-4d2f-8e3c-9b0f7a5d4c32';

describe('checkoutReportFromScan', () => {
  it('prefers the key the scanner computed and derives one from the URL otherwise', () => {
    const r = checkoutReportFromScan({
      host: 'pc-a',
      machineId: A,
      root: '/w',
      projects: [
        { path: '/w/a', repoUrl: 'git@gh-work:acme/a.git', repoKey: 'github.com/acme/a' },
        { path: '/w/b', repoUrl: 'https://github.com/Acme/B.git' },
        { path: '/w/c' },
      ],
    });
    expect(r).toEqual({
      machineId: A,
      label: 'pc-a',
      entries: [
        { repoKey: 'github.com/acme/a', folder: '/w/a' },
        { repoKey: 'github.com/acme/b', folder: '/w/b' },
      ],
    });
  });

  it('reports nothing for a scan with no machine id', () => {
    expect(
      checkoutReportFromScan({
        host: 'old-cli',
        root: '/w',
        projects: [{ path: '/w/a', repoUrl: 'https://github.com/acme/a' }],
      }),
    ).toBeNull();
  });
});

describe('createCheckoutBackend', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hub-checkouts-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists two PCs with one repo at different paths under one key', async () => {
    let notified = 0;
    const backend = createCheckoutBackend({
      file: join(dir, 'checkouts.json'),
      notify: () => {
        notified += 1;
      },
    });
    await backend.reportCheckouts({
      machineId: A,
      label: 'pc-a',
      entries: [{ repoKey: 'github.com/acme/a', folder: '/Users/a/src/a' }],
    });
    await backend.reportCheckouts({
      machineId: B,
      label: 'pc-b',
      entries: [{ repoKey: 'github.com/acme/a', folder: '/home/b/work/a' }],
    });
    const rows = await backend.listCheckouts({ repoKey: 'github.com/acme/a' });
    expect(rows.map((r) => r.folder).sort()).toEqual(['/Users/a/src/a', '/home/b/work/a']);
    expect(notified).toBe(2);
  });
});
