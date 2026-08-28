import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hostBackupHasCredentials,
  hostClaudeAccessTokenExpired,
  hostClaudeLoginDead,
  isRealAgentCredential,
  parseExtractResult,
  parseSyncResult,
  parseVolumeClaudeCredentials,
  SYNC_SCRIPT,
} from '../src/sync/claude-credentials.js';

describe('parseExtractResult', () => {
  it('reports copied only on COPIED=yes', () => {
    expect(parseExtractResult('COPIED=yes')).toEqual({ copied: true });
    expect(parseExtractResult('COPIED=no')).toEqual({ copied: false });
    expect(parseExtractResult('garbage')).toEqual({ copied: false });
  });
});

describe('parseVolumeClaudeCredentials', () => {
  it('reads a present file with a usable refresh token', () => {
    expect(parseVolumeClaudeCredentials('PRESENT=yes REFRESH=yes')).toEqual({
      present: true,
      hasRefreshToken: true,
    });
  });

  it('reports a present-but-blanked file (the dead state) as no refresh token', () => {
    expect(parseVolumeClaudeCredentials('PRESENT=yes REFRESH=no')).toEqual({
      present: true,
      hasRefreshToken: false,
    });
  });

  it('reports an absent file', () => {
    expect(parseVolumeClaudeCredentials('PRESENT=no REFRESH=no')).toEqual({
      present: false,
      hasRefreshToken: false,
    });
  });

  it('is tolerant of empty / garbage output', () => {
    expect(parseVolumeClaudeCredentials('')).toEqual({
      present: false,
      hasRefreshToken: false,
    });
    expect(parseVolumeClaudeCredentials('docker: command not found')).toEqual({
      present: false,
      hasRefreshToken: false,
    });
  });
});

describe('hostClaudeAccessTokenExpired', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'abx-exp-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (obj: unknown) => {
    const p = join(dir, 'creds.json');
    await writeFile(p, JSON.stringify(obj));
    return p;
  };

  it('true when expiresAt is in the past', async () => {
    const p = await write({ claudeAiOauth: { refreshToken: 'rt', expiresAt: 1000 } });
    expect(await hostClaudeAccessTokenExpired(p, 2000)).toBe(true);
  });
  it('false when expiresAt is in the future', async () => {
    const p = await write({ claudeAiOauth: { refreshToken: 'rt', expiresAt: 5000 } });
    expect(await hostClaudeAccessTokenExpired(p, 2000)).toBe(false);
  });
  it('false when expiresAt is absent (do not nag)', async () => {
    const p = await write({ claudeAiOauth: { refreshToken: 'rt' } });
    expect(await hostClaudeAccessTokenExpired(p, 2000)).toBe(false);
  });
  it('false on a missing/garbage file', async () => {
    expect(await hostClaudeAccessTokenExpired(join(dir, 'nope.json'), 2000)).toBe(false);
  });

  // The two predicates must stay distinguishable through the docker re-export:
  // a lapsed access token is a healthy login, only a spent refresh token is dead.
  it('is not the same question as hostClaudeLoginDead', async () => {
    const p = await write({
      claudeAiOauth: { refreshToken: 'rt', expiresAt: 1000, refreshTokenExpiresAt: 9000 },
    });
    expect(await hostClaudeAccessTokenExpired(p, 2000)).toBe(true);
    expect(await hostClaudeLoginDead(p, 2000)).toBe(false);

    const spent = await write({
      claudeAiOauth: { refreshToken: 'rt', expiresAt: 5000, refreshTokenExpiresAt: 1000 },
    });
    expect(await hostClaudeLoginDead(spent, 2000)).toBe(true);
  });
});

describe('isRealAgentCredential', () => {
  it('claude requires a non-empty claudeAiOauth.refreshToken', () => {
    expect(
      isRealAgentCredential('claude', JSON.stringify({ claudeAiOauth: { refreshToken: 'x' } })),
    ).toBe(true);
    expect(
      isRealAgentCredential('claude', JSON.stringify({ claudeAiOauth: { refreshToken: '' } })),
    ).toBe(false);
    expect(isRealAgentCredential('claude', JSON.stringify({ claudeAiOauth: {} }))).toBe(false);
    expect(isRealAgentCredential('claude', '{}')).toBe(false);
  });

  it('codex/opencode accept any non-empty JSON object', () => {
    expect(isRealAgentCredential('codex', '{"OPENAI_API_KEY":"sk"}')).toBe(true);
    expect(isRealAgentCredential('opencode', '{"anthropic":{}}')).toBe(true);
    expect(isRealAgentCredential('codex', '{}')).toBe(false);
  });

  it('rejects non-JSON / empty / non-object input', () => {
    expect(isRealAgentCredential('claude', '')).toBe(false);
    expect(isRealAgentCredential('codex', 'not json')).toBe(false);
    expect(isRealAgentCredential('opencode', '[]')).toBe(false);
    expect(isRealAgentCredential('codex', 'null')).toBe(false);
  });
});

describe('parseSyncResult', () => {
  it('reports extracted when the volume creds were copied to the host backup', () => {
    expect(parseSyncResult('EXTRACTED=yes SEEDED=no VOLREAL=yes')).toEqual({
      direction: 'extracted',
      volumeHasCredentials: true,
    });
  });

  it('reports seeded when the host backup was copied into the volume', () => {
    expect(parseSyncResult('EXTRACTED=no SEEDED=yes VOLREAL=yes')).toEqual({
      direction: 'seeded',
      volumeHasCredentials: true,
    });
  });

  it('reports noop with no creds when nothing was synced', () => {
    expect(parseSyncResult('EXTRACTED=no SEEDED=no VOLREAL=no')).toEqual({
      direction: 'noop',
      volumeHasCredentials: false,
    });
  });

  it('reports noop but volumeHasCredentials=true for an isolate box that already had creds', () => {
    expect(parseSyncResult('EXTRACTED=no SEEDED=no VOLREAL=yes')).toEqual({
      direction: 'noop',
      volumeHasCredentials: true,
    });
  });

  it('treats garbage / empty output as a noop with no creds', () => {
    expect(parseSyncResult('')).toEqual({ direction: 'noop', volumeHasCredentials: false });
    expect(parseSyncResult('docker: command not found')).toEqual({
      direction: 'noop',
      volumeHasCredentials: false,
    });
  });
});

describe('hostBackupHasCredentials', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-cred-test-'));
    path = join(dir, 'claude-credentials.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns false when the file does not exist', async () => {
    expect(await hostBackupHasCredentials(path)).toBe(false);
  });

  it('returns true for a real OAuth blob with a non-empty refreshToken', async () => {
    await writeFile(
      path,
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'sk-ant-ort01-x' } }),
    );
    expect(await hostBackupHasCredentials(path)).toBe(true);
  });

  it('returns false when refreshToken is missing or empty', async () => {
    await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }));
    expect(await hostBackupHasCredentials(path)).toBe(false);
    await writeFile(path, JSON.stringify({ claudeAiOauth: { refreshToken: '' } }));
    expect(await hostBackupHasCredentials(path)).toBe(false);
  });

  it('returns false for garbage JSON', async () => {
    await writeFile(path, '{not json');
    expect(await hostBackupHasCredentials(path)).toBe(false);
  });
});

/**
 * SYNC_SCRIPT is the shell that decides which way a credential moves between the
 * shared volume and the host backup, and getting that direction wrong logs the
 * whole fleet out (a Claude refresh rotates the token, so the older blob is dead,
 * not merely stale). It is plain POSIX sh + jq, so run the real thing here rather
 * than restating its logic in a mock.
 *
 * In production the container runs as root; as a test user the seed branch's
 * `chown 1000:1000` would fail and mask the outcome, so shim `chown` on PATH.
 */
describe('SYNC_SCRIPT direction (newest expiresAt wins)', () => {
  let dir: string;
  let binDir: string;
  let hasJq = true;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'abx-sync-script-'));
    binDir = join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(dir, 'dst'), { recursive: true });
    await mkdir(join(dir, 'host-state'), { recursive: true });
    const shim = join(binDir, 'chown');
    await writeFile(shim, '#!/bin/sh\nexit 0\n');
    await chmod(shim, 0o755);
    try {
      await execa('jq', ['--version']);
    } catch {
      hasJq = false;
    }
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const blob = (expiresAt: number, refreshToken = 'rt'): string =>
    JSON.stringify({ claudeAiOauth: { refreshToken, expiresAt, refreshTokenExpiresAt: 9e12 } });

  const volPath = () => join(dir, 'dst', '.credentials.json');
  const hostPath = () => join(dir, 'host-state', 'claude-credentials.json');

  /** Run the real script with /dst and /host-state rebound to temp dirs. */
  const run = async (isolate = false): Promise<string> => {
    const script = SYNC_SCRIPT.replaceAll('/dst/', `${join(dir, 'dst')}/`).replaceAll(
      '/host-state/',
      `${join(dir, 'host-state')}/`,
    );
    const { stdout } = await execa('sh', ['-c', script], {
      env: { ISOLATE: isolate ? 'yes' : 'no', PATH: `${binDir}:${process.env['PATH'] ?? ''}` },
      extendEnv: false,
    });
    return stdout;
  };

  it('extracts when the volume blob is newer than the backup', async () => {
    await writeFile(volPath(), blob(2000));
    await writeFile(hostPath(), blob(1000));
    if (!hasJq) return;
    expect(parseSyncResult(await run())).toEqual({
      direction: 'extracted',
      volumeHasCredentials: true,
    });
    expect(JSON.parse(await readFile(hostPath(), 'utf8')).claudeAiOauth.expiresAt).toBe(2000);
  });

  // The regression that started this: a stale volume used to overwrite a fresher
  // backup, replacing a live token with one that had already been rotated away.
  it('does NOT extract when the volume blob is older — it seeds the volume instead', async () => {
    await writeFile(volPath(), blob(1000));
    await writeFile(hostPath(), blob(2000));
    if (!hasJq) return;
    expect(parseSyncResult(await run())).toEqual({
      direction: 'seeded',
      volumeHasCredentials: true,
    });
    expect(JSON.parse(await readFile(hostPath(), 'utf8')).claudeAiOauth.expiresAt).toBe(2000);
    expect(JSON.parse(await readFile(volPath(), 'utf8')).claudeAiOauth.expiresAt).toBe(2000);
  });

  it('is a noop when both sides carry the same blob', async () => {
    await writeFile(volPath(), blob(2000));
    await writeFile(hostPath(), blob(2000));
    if (!hasJq) return;
    expect(parseSyncResult(await run())).toEqual({
      direction: 'noop',
      volumeHasCredentials: true,
    });
  });

  it('seeds an empty volume from the backup', async () => {
    await writeFile(hostPath(), blob(2000));
    if (!hasJq) return;
    expect(parseSyncResult(await run())).toEqual({
      direction: 'seeded',
      volumeHasCredentials: true,
    });
  });

  it('extracts to an absent backup regardless of expiry', async () => {
    await writeFile(volPath(), blob(1000));
    if (!hasJq) return;
    expect(parseSyncResult(await run())).toEqual({
      direction: 'extracted',
      volumeHasCredentials: true,
    });
  });

  it('repairs a volume whose refresh token was blanked by a rejected refresh', async () => {
    await writeFile(volPath(), blob(3000, ''));
    await writeFile(hostPath(), blob(1000));
    if (!hasJq) return;
    expect(parseSyncResult(await run())).toEqual({
      direction: 'seeded',
      volumeHasCredentials: true,
    });
  });

  it('never extracts under ISOLATE, but still seeds a newer backup in', async () => {
    await writeFile(volPath(), blob(2000));
    await writeFile(hostPath(), blob(1000));
    if (!hasJq) return;
    expect(parseSyncResult(await run(true))).toEqual({
      direction: 'noop',
      volumeHasCredentials: true,
    });
    await writeFile(hostPath(), blob(3000));
    expect(parseSyncResult(await run(true))).toEqual({
      direction: 'seeded',
      volumeHasCredentials: true,
    });
  });
});
