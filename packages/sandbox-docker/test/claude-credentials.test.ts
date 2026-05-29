import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hostBackupHasCredentials,
  isRealAgentCredential,
  parseSyncResult,
} from '../src/claude-credentials.js';

describe('isRealAgentCredential', () => {
  it('claude requires a non-empty claudeAiOauth.refreshToken', () => {
    expect(isRealAgentCredential('claude', JSON.stringify({ claudeAiOauth: { refreshToken: 'x' } }))).toBe(true);
    expect(isRealAgentCredential('claude', JSON.stringify({ claudeAiOauth: { refreshToken: '' } }))).toBe(false);
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
