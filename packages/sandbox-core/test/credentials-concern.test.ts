import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRecordingTransport } from '../src/sync/recording-transport.js';
import {
  SEED_MARKER,
  extractCredentials,
  claudeRefreshExpiresAt,
  hostBackupHasCredentials,
  hostClaudeAccessTokenExpired,
  hostClaudeLoginDead,
  isRealAgentCredential,
} from '../src/sync/concerns/credentials.js';

// The guard cases mirror sandbox-docker/test/claude-credentials.test.ts exactly:
// these functions moved here (docker now re-exports them), so identical cases on
// both sides prove the move is behavior-preserving.
describe('credentials concern — guards', () => {
  describe('isRealAgentCredential (registry realShape)', () => {
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

  describe('hostClaudeAccessTokenExpired', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'abx-core-exp-'));
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
  });

  describe('claudeRefreshExpiresAt', () => {
    it('reads refreshTokenExpiresAt, null when absent or unparseable', () => {
      expect(
        claudeRefreshExpiresAt(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 42 } })),
      ).toBe(42);
      expect(claudeRefreshExpiresAt(JSON.stringify({ claudeAiOauth: { expiresAt: 42 } }))).toBe(
        null,
      );
      expect(
        claudeRefreshExpiresAt(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 'no' } })),
      ).toBe(null);
      expect(claudeRefreshExpiresAt('not json')).toBe(null);
    });
  });

  // The distinction this whole gate exists for: a lapsed ACCESS token is a
  // healthy login that renews itself, and reporting it as expired produced a
  // daily false alarm whose "fix" (a login container) rotated the shared token.
  describe('hostClaudeLoginDead', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'abx-core-dead-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const write = async (obj: unknown) => {
      const p = join(dir, 'creds.json');
      await writeFile(p, JSON.stringify(obj));
      return p;
    };

    it('false when the access token lapsed but the refresh token is alive', async () => {
      const p = await write({
        claudeAiOauth: { refreshToken: 'rt', expiresAt: 1000, refreshTokenExpiresAt: 9000 },
      });
      expect(await hostClaudeLoginDead(p, 2000)).toBe(false);
      expect(await hostClaudeAccessTokenExpired(p, 2000)).toBe(true);
    });
    it('true when the refresh token itself has expired', async () => {
      const p = await write({
        claudeAiOauth: { refreshToken: 'rt', expiresAt: 5000, refreshTokenExpiresAt: 1000 },
      });
      expect(await hostClaudeLoginDead(p, 2000)).toBe(true);
    });
    it('true when the refresh token is blank (claude blanks it on a rejected refresh)', async () => {
      const p = await write({ claudeAiOauth: { refreshToken: '', refreshTokenExpiresAt: 9000 } });
      expect(await hostClaudeLoginDead(p, 2000)).toBe(true);
    });
    it('false when refreshTokenExpiresAt is absent (never declare death on a guess)', async () => {
      const p = await write({ claudeAiOauth: { refreshToken: 'rt', expiresAt: 1000 } });
      expect(await hostClaudeLoginDead(p, 2000)).toBe(false);
    });
    it('false on a missing file (nothing saved is "missing", not "dead")', async () => {
      expect(await hostClaudeLoginDead(join(dir, 'nope.json'), 2000)).toBe(false);
    });
    it('true on a garbage file that exists', async () => {
      const p = join(dir, 'creds.json');
      await writeFile(p, 'not json');
      expect(await hostClaudeLoginDead(p, 2000)).toBe(true);
    });
  });

  describe('hostBackupHasCredentials', () => {
    let dir: string;
    let path: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'abx-core-has-'));
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

  it('exposes the shared seed-once marker name', () => {
    expect(SEED_MARKER).toBe('.agentbox-seeded-at');
  });
});

// Golden-test the box→host extract against the RecordingSyncTransport: the
// concern's whole observable effect is the ordered `readText` calls (one per
// registry agent, at the canonical box path) + the host backups it writes.
describe('credentials concern — extractCredentials', () => {
  let dir: string;
  const realClaude = JSON.stringify({ claudeAiOauth: { refreshToken: 'rt-real' } });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'abx-core-extract-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const backups = () => ({
    claude: join(dir, 'claude-credentials.json'),
    codex: join(dir, 'codex-credentials.json'),
    opencode: join(dir, 'opencode-credentials.json'),
  });

  it('reads each agent box path and writes only real creds (0600)', async () => {
    const t = makeRecordingTransport({
      readText: (p) => {
        if (p === '/home/vscode/.claude/.credentials.json') return realClaude;
        if (p === '/home/vscode/.codex/auth.json') return '{}'; // empty object → not "real"
        return null; // opencode missing → exit 1 → null
      },
    });
    const b = backups();
    const extracted = await extractCredentials(t, { backups: b });
    expect(extracted).toEqual(['claude']);

    // One readText per agent, in registry order, at the canonical box paths.
    expect(t.ops.map((o) => o.op)).toEqual(['readText', 'readText', 'readText']);
    expect(t.ops.map((o) => o.args['boxPath'])).toEqual([
      '/home/vscode/.claude/.credentials.json',
      '/home/vscode/.codex/auth.json',
      '/home/vscode/.local/share/opencode/auth.json',
    ]);

    expect(await readFile(b.claude, 'utf8')).toBe(realClaude);
    expect((await stat(b.claude)).mode & 0o777).toBe(0o600);
    await expect(stat(b.codex)).rejects.toThrow();
    await expect(stat(b.opencode)).rejects.toThrow();
  });

  it('extracts codex + opencode when their auth files are non-empty JSON', async () => {
    const t = makeRecordingTransport({
      readText: (p) => {
        if (p === '/home/vscode/.codex/auth.json') return '{"OPENAI_API_KEY":"sk-x"}';
        if (p === '/home/vscode/.local/share/opencode/auth.json')
          return '{"anthropic":{"type":"oauth"}}';
        return null;
      },
    });
    const extracted = await extractCredentials(t, { backups: backups() });
    expect(extracted.sort()).toEqual(['codex', 'opencode']);
  });

  it('swallows a per-agent readText failure and continues (returns [])', async () => {
    const t = makeRecordingTransport({
      readText: () => {
        throw new Error('transient');
      },
    });
    const logs: string[] = [];
    const extracted = await extractCredentials(t, {
      backups: backups(),
      onLog: (l) => logs.push(l),
    });
    expect(extracted).toEqual([]);
    expect(logs.some((l) => l.includes('extract failed'))).toBe(true);
  });
});
