import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeExpiresAt,
  makeRecordingTransport,
  parseCredentialsUpdate,
  pushCredentialToBox,
  readCredentialBackup,
  shouldAcceptCredentialUpdate,
  writeCredentialBackup,
} from '../src/index.js';

const claudeBlob = (expiresAt: number, refresh = 'r') =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: refresh, expiresAt } });

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('parseCredentialsUpdate', () => {
  it('accepts a valid claude payload and decodes the content', () => {
    const update = parseCredentialsUpdate({
      schema: 1,
      agent: 'claude',
      contentBase64: b64(claudeBlob(123)),
      capturedAt: 'x',
    });
    expect(update).not.toBeNull();
    expect(update!.agent).toBe('claude');
    expect(claudeExpiresAt(update!.content)).toBe(123);
  });

  it.each([
    ['unknown agent', { agent: 'gpt', contentBase64: b64('{"a":1}') }],
    ['missing content', { agent: 'codex' }],
    ['placeholder claude blob', { agent: 'claude', contentBase64: b64('{"claudeAiOauth":{"refreshToken":""}}') }],
    ['empty json for codex', { agent: 'codex', contentBase64: b64('{}') }],
    ['non-object', 'nope'],
  ])('rejects %s', (_name, payload) => {
    expect(parseCredentialsUpdate(payload)).toBeNull();
  });
});

describe('shouldAcceptCredentialUpdate', () => {
  it('claude: newest expiresAt wins, equal or older rejected', () => {
    expect(shouldAcceptCredentialUpdate('claude', claudeBlob(200), claudeBlob(100)).accept).toBe(true);
    expect(shouldAcceptCredentialUpdate('claude', claudeBlob(100), claudeBlob(100, 'other')).accept).toBe(false);
    expect(shouldAcceptCredentialUpdate('claude', claudeBlob(50), claudeBlob(100)).accept).toBe(false);
  });

  it('claude: accepts when there is no existing backup or it has no expiresAt', () => {
    expect(shouldAcceptCredentialUpdate('claude', claudeBlob(200), null).accept).toBe(true);
    expect(
      shouldAcceptCredentialUpdate(
        'claude',
        claudeBlob(200),
        JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }),
      ).accept,
    ).toBe(true);
  });

  it('claude: rejects an incoming blob with no expiresAt (cannot order)', () => {
    expect(
      shouldAcceptCredentialUpdate(
        'claude',
        JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }),
        claudeBlob(100),
      ).accept,
    ).toBe(false);
  });

  it('codex/opencode: content change wins, identical is a no-op', () => {
    expect(shouldAcceptCredentialUpdate('codex', '{"t":"new"}', '{"t":"old"}').accept).toBe(true);
    expect(shouldAcceptCredentialUpdate('codex', '{"t":"same"}', '{"t":"same"}').accept).toBe(false);
    expect(shouldAcceptCredentialUpdate('opencode', '{"t":"x"}', null).accept).toBe(true);
  });
});

describe('writeCredentialBackup / readCredentialBackup', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cred-backup-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes 0600 and round-trips', async () => {
    const path = join(dir, 'claude-credentials.json');
    await writeCredentialBackup('claude', claudeBlob(1), { backupPath: path });
    expect(await readCredentialBackup('claude', { backupPath: path })).toBe(claudeBlob(1));
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe(claudeBlob(1));
  });

  it('read returns null when absent', async () => {
    expect(await readCredentialBackup('claude', { backupPath: join(dir, 'nope') })).toBeNull();
  });
});

describe('pushCredentialToBox', () => {
  it('pushes to the canonical path and normalizes owner/mode', async () => {
    const t = makeRecordingTransport();
    await pushCredentialToBox(t, 'claude', claudeBlob(9));
    const push = t.ops.find((o) => o.op === 'pushFile');
    expect(push!.args['boxDestPath']).toBe('/home/vscode/.claude/.credentials.json');
    const execs = t.ops.filter((o) => o.op === 'exec');
    expect(execs.some((e) => (e.args['cmd'] as string[]).join(' ').includes('mkdir -p'))).toBe(true);
    expect(execs.some((e) => (e.args['cmd'] as string[]).join(' ').includes('chmod 600'))).toBe(true);
  });

  it('fails loudly when the in-box normalize fails', async () => {
    const t = makeRecordingTransport({
      execResult: (cmd) =>
        cmd.join(' ').includes('chmod')
          ? { exitCode: 1, stdout: '', stderr: 'denied' }
          : { exitCode: 0, stdout: '', stderr: '' },
    });
    await expect(pushCredentialToBox(t, 'codex', '{"k":1}')).rejects.toThrow('denied');
  });
});
