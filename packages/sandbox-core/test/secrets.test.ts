import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskSecret, secretsEnvPath, writeManagedSecrets } from '../src/secrets.js';

// writeManagedSecrets writes to `~/.agentbox/secrets.env` via os.homedir(),
// which honors $HOME on POSIX — so we redirect HOME to an isolated tmp dir and
// never touch the real home.
describe('writeManagedSecrets', () => {
  let home: string;
  let prevHome: string | undefined;
  const MANAGED = ['FOO_TOKEN', 'FOO_TEAM'] as const;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agentbox-secrets-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    for (const k of MANAGED) delete process.env[k];
    delete process.env.UNRELATED;
  });
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    for (const k of MANAGED) delete process.env[k];
    await rm(home, { recursive: true, force: true });
  });

  it('writes managed keys, mirrors into process.env, and is 0600', async () => {
    writeManagedSecrets(MANAGED, { FOO_TOKEN: 'tok123', FOO_TEAM: 'team_x' });
    const body = await readFile(secretsEnvPath(), 'utf8');
    expect(body).toContain('FOO_TOKEN=tok123');
    expect(body).toContain('FOO_TEAM=team_x');
    expect(process.env.FOO_TOKEN).toBe('tok123');
    expect(statSync(secretsEnvPath()).mode & 0o777).toBe(0o600);
  });

  it('strips prior managed values (no duplicates) and preserves unrelated lines', async () => {
    await mkdir(join(home, '.agentbox'), { recursive: true });
    await writeFile(
      secretsEnvPath(),
      'UNRELATED=keepme\nexport FOO_TOKEN=old\nFOO_TEAM=oldteam\n',
      'utf8',
    );
    writeManagedSecrets(MANAGED, { FOO_TOKEN: 'new' });
    const body = await readFile(secretsEnvPath(), 'utf8');
    expect(body).toContain('UNRELATED=keepme');
    expect(body).toContain('FOO_TOKEN=new');
    // old value and the alternate managed key are gone
    expect(body).not.toContain('old');
    expect(body).not.toContain('FOO_TEAM=oldteam');
    // switching to a single key clears the other managed key from env too
    expect(process.env.FOO_TEAM).toBeUndefined();
  });
});

describe('maskSecret', () => {
  it('masks short values fully and long values partially', () => {
    expect(maskSecret('short')).toBe('*****');
    expect(maskSecret('abcd12345678wxyz')).toBe('abcd…********wxyz');
    expect(maskSecret('abcd12345678wxyz')).not.toContain('12345678');
  });
});
