import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { pushCreateSeed } from '../src/control-plane/create-target.js';

/**
 * `pushCreateSeed` is the layer where the loud-carry rule was first lost: the
 * throw lives in `pushProjectSeedToCustody`, but this function wrapped the whole
 * push in a best-effort catch that turned every failure — including an approved
 * `carry:` — back into a log line, so the create carried on and built a box
 * without the files the user said yes to.
 *
 * These drive the real function against a stub control box, because testing the
 * inner throw in isolation is exactly what missed this.
 */
const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

/** A git repo with an origin and one gitignored file to carry. */
async function makeRepo(): Promise<{ dir: string; carryAbs: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentbox-carry-push-')));
  scratch.push(dir);
  const git = (args: string[]) => execa('git', ['-C', dir, ...args], { env: GIT_ENV });
  await git(['init', '-q']);
  await git(['config', 'user.email', 't@t.test']);
  await git(['config', 'user.name', 'T']);
  await git(['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  await writeFile(join(dir, '.gitignore'), 'backups/\n');
  await writeFile(join(dir, 'README.md'), '# r');
  await git(['add', '.']);
  await git(['commit', '-qm', 'init']);
  await mkdir(join(dir, 'backups'), { recursive: true });
  await writeFile(join(dir, 'backups', 'dump.bin'), 'pretend this is a database dump');
  return { dir, carryAbs: join(dir, 'backups', 'dump.bin') };
}

function carryEntry(absSrc: string) {
  return {
    rawSrc: './backups/dump.bin',
    rawDest: '/workspace/backups/dump.bin',
    absSrc,
    absDest: '/workspace/backups/dump.bin',
    kind: 'file' as const,
    optional: false,
  };
}

/** A stub control box whose custody PUT always fails with `status`. */
async function refusingHub(status: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    // `hostReachable` probes before the push; keep that green so the test
    // exercises the PUT failure rather than the unreachable branch.
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"entries":[]}');
      return;
    }
    req.resume();
    req.on('end', () => res.writeHead(status).end('{"error":"nope"}'));
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}

describe('pushCreateSeed and approved carry', () => {
  it('THROWS when the control box refuses an approved carry entry', async () => {
    const { dir, carryAbs } = await makeRepo();
    const hub = await refusingHub(413);
    try {
      await expect(
        pushCreateSeed({
          custody: { url: hub.url, adminToken: 'tok' },
          repoUrl: 'https://github.com/o/r.git',
          projectRoot: dir,
          carry: [carryEntry(carryAbs)],
          onLog: () => {},
        }),
      ).rejects.toThrow(/carry/i);
    } finally {
      await hub.close();
    }
  });

  it('THROWS when the control box is unreachable and carry was approved', async () => {
    const { dir, carryAbs } = await makeRepo();
    // Nothing listening: the reachability probe fails, which used to be a log
    // line — leaving the box to come up without the approved files.
    await expect(
      pushCreateSeed({
        custody: { url: 'http://127.0.0.1:1', adminToken: 'tok' },
        repoUrl: 'https://github.com/o/r.git',
        projectRoot: dir,
        carry: [carryEntry(carryAbs)],
        onLog: () => {},
      }),
    ).rejects.toThrow(/carry/i);
  });

  it('still swallows a plain seed failure (no carry approved)', async () => {
    // The contrast that makes the rule legible: without approved carry, an
    // unreachable control box must NOT fail the create.
    const { dir } = await makeRepo();
    const logs: string[] = [];
    await expect(
      pushCreateSeed({
        custody: { url: 'http://127.0.0.1:1', adminToken: 'tok' },
        repoUrl: 'https://github.com/o/r.git',
        projectRoot: dir,
        onLog: (l) => logs.push(l),
      }),
    ).resolves.toBeUndefined();
    expect(logs.join('\n')).toMatch(/unreachable/i);
  });
});
