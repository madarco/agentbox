import { describe, expect, it, vi } from 'vitest';

// login-fanout reads the account store and the credential backups from $HOME at import.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os');
  process.env.HOME = mk(`${td()}/agentbox-acct-store-`);
});

import { atomicVolumeWriteScript, bestEffort } from '../src/lib/login-fanout.js';

describe('atomicVolumeWriteScript (a hub sign-in writes the account volume)', () => {
  it('writes a temp file beside the target, then renames it over', () => {
    const script = atomicVolumeWriteScript('.credentials.json');
    expect(script).toContain(`t='/dst/.credentials.json.tmp.'$$`);
    expect(script).toContain('cat > "$t"');
    expect(script).toContain(`mv -f "$t" '/dst/.credentials.json'`);
    expect(script).toContain('chmod 600 "$t"');
    // Never a plain write into the live file a box re-reads.
    expect(script).not.toContain(`cat > '/dst/.credentials.json'`);
    expect(script.indexOf('chown')).toBeLessThan(script.indexOf('mv -f'));
  });

  it('creates the parent of a nested path, and refuses an unsafe one', () => {
    expect(atomicVolumeWriteScript('auth/auth.json')).toContain(`mkdir -p '/dst/auth'`);
    expect(() => atomicVolumeWriteScript('../etc/passwd')).toThrow(/unsafe/);
    expect(() => atomicVolumeWriteScript("a'; rm -rf /")).toThrow(/unsafe/);
  });
});

describe('bestEffort (a step after the login is stored)', () => {
  it('logs a failure and never throws, so the sign-in still ends signed in', async () => {
    const lines: string[] = [];
    const ok = await bestEffort(
      'resetting the profile in v',
      () => Promise.reject(new Error('docker: no space left')),
      (l) => lines.push(l),
    );
    expect(ok).toBe(false);
    expect(lines).toEqual([
      'resetting the profile in v failed (the login is stored): docker: no space left',
    ]);
  });

  it('reports success when the step ran', async () => {
    const lines: string[] = [];
    expect(
      await bestEffort(
        'x',
        () => Promise.resolve(),
        (l) => lines.push(l),
      ),
    ).toBe(true);
    expect(lines).toEqual([]);
  });
});
