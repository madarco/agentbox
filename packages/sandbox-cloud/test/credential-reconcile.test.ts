import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRecordingTransport } from '@agentbox/sandbox-core';
import { reconcileAgentCredentialsViaTransport } from '../src/index.js';

const claudeBlob = (expiresAt: number, refresh = 'r') =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: refresh, expiresAt } });

const CLAUDE_BOX_PATH = '/home/vscode/.claude/.credentials.json';

describe('reconcileAgentCredentialsViaTransport', () => {
  let dir: string;
  let backups: Record<'claude' | 'codex' | 'opencode', string>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reconcile-'));
    backups = {
      claude: join(dir, 'claude-credentials.json'),
      codex: join(dir, 'codex-credentials.json'),
      opencode: join(dir, 'opencode-credentials.json'),
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('pushes the host claude blob when it is newer than the box copy', async () => {
    await writeFile(backups.claude, claudeBlob(200));
    const t = makeRecordingTransport({
      readText: (path) => (path === CLAUDE_BOX_PATH ? claudeBlob(100, 'stale') : null),
    });
    await reconcileAgentCredentialsViaTransport(t, { backups });
    const push = t.ops.find((o) => o.op === 'pushFile');
    expect(push).toBeDefined();
    expect(push!.args['boxDestPath']).toBe(CLAUDE_BOX_PATH);
  });

  it('captures the box claude blob to the backup when the box is newer', async () => {
    await writeFile(backups.claude, claudeBlob(100));
    const t = makeRecordingTransport({
      readText: (path) => (path === CLAUDE_BOX_PATH ? claudeBlob(300, 'fresher') : null),
    });
    await reconcileAgentCredentialsViaTransport(t, { backups });
    expect(t.ops.filter((o) => o.op === 'pushFile')).toHaveLength(0);
    expect(await readFile(backups.claude, 'utf8')).toBe(claudeBlob(300, 'fresher'));
  });

  it('does nothing when box and host blobs are identical', async () => {
    await writeFile(backups.claude, claudeBlob(100));
    const t = makeRecordingTransport({
      readText: (path) => (path === CLAUDE_BOX_PATH ? claudeBlob(100) : null),
    });
    await reconcileAgentCredentialsViaTransport(t, { backups });
    expect(t.ops.filter((o) => o.op === 'pushFile')).toHaveLength(0);
    expect(await readFile(backups.claude, 'utf8')).toBe(claudeBlob(100));
  });

  it('codex: host-wins on difference, no capture of the box copy', async () => {
    await writeFile(backups.codex, '{"token":"host"}');
    const t = makeRecordingTransport({
      readText: (path) =>
        path === '/home/vscode/.codex/auth.json' ? '{"token":"box"}' : null,
    });
    await reconcileAgentCredentialsViaTransport(t, { backups });
    const push = t.ops.find((o) => o.op === 'pushFile');
    expect(push!.args['boxDestPath']).toBe('/home/vscode/.codex/auth.json');
    expect(await readFile(backups.codex, 'utf8')).toBe('{"token":"host"}');
  });

  it('captures a real box blob when the host backup is missing', async () => {
    const t = makeRecordingTransport({
      readText: (path) =>
        path === '/home/vscode/.local/share/opencode/auth.json' ? '{"k":"v"}' : null,
    });
    await reconcileAgentCredentialsViaTransport(t, { backups });
    expect(await readFile(backups.opencode, 'utf8')).toBe('{"k":"v"}');
    expect(t.ops.filter((o) => o.op === 'pushFile')).toHaveLength(0);
  });

  it('skips agents with neither a host backup nor a box blob', async () => {
    const t = makeRecordingTransport();
    await reconcileAgentCredentialsViaTransport(t, { backups });
    expect(t.ops.filter((o) => o.op === 'pushFile')).toHaveLength(0);
  });
});
