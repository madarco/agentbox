import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectCarryFile } from '../src/paths.js';
import { readCarryGrant, writeCarryGrant } from '../src/carry-grant.js';
import { resetTempAgentboxHome } from '../../../scripts/test-home.js';

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-carry-grant-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await resetTempAgentboxHome();
});

const grant = {
  approvedId: 'carry-grant:9f2a1c4e77b0',
  approvedAt: '2026-09-10T09:12:44.301Z',
  files: [
    { src: '~/.agentbox/secrets.env', dest: '~/.agentbox/secrets.env', kind: 'file', mode: '0600' },
  ],
};

describe('carry grant', () => {
  it('round-trips, creating the per-project dir', async () => {
    await writeCarryGrant(root, grant);
    expect(await readCarryGrant(root)).toEqual(grant);
    // Readable by a human, not an opaque digest — the approval is auditable.
    const text = await readFile(projectCarryFile(root), 'utf8');
    expect(text).toContain('secrets.env');
    expect(text).toContain('# agentbox carry grant');
  });

  it('reads as undefined when there is none', async () => {
    expect(await readCarryGrant(root)).toBeUndefined();
  });

  it('replaces rather than merges — an approval is of a whole list', async () => {
    await writeCarryGrant(root, grant);
    const next = { ...grant, approvedId: 'carry-grant:000000000000', files: [] };
    await writeCarryGrant(root, next);
    expect((await readCarryGrant(root))?.approvedId).toBe('carry-grant:000000000000');
    expect((await readCarryGrant(root))?.files).toEqual([]);
  });

  it('fails closed on a malformed file rather than approximating an approval', async () => {
    await writeCarryGrant(root, grant);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(projectCarryFile(root), 'approvedAt: 2026-01-01\n'); // no approvedId
    expect(await readCarryGrant(root)).toBeUndefined();
    await writeFile(projectCarryFile(root), ': not : yaml :\n');
    expect(await readCarryGrant(root)).toBeUndefined();
  });
});
