import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS, makeRecordingTransport } from '@agentbox/sandbox-core';
import { reconcileAgentCredentialsViaTransport } from '../src/index.js';

const claudeBlob = (expiresAt: number, refresh = 'r') =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: refresh, expiresAt } });

const CLAUDE_BOX_PATH = '/home/vscode/.claude/.credentials.json';

describe('reconcileAgentCredentialsViaTransport', () => {
  let dir: string;
  // The three this fixture ASSERTS on stay declared `string` so they need no
  // `!`; every other registered agent is filled in from the registry below,
  // purely so none of them can fall through to the real home.
  let backups: Record<string, string> & { claude: string; codex: string; opencode: string };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reconcile-'));
    // EVERY registered agent gets a temp backup path, not just the three this
    // fixture asserts on. `reconcileAgentCredentialsViaTransport` walks the
    // whole registry, so an agent missing from this map falls back to the real
    // `~/.agentbox/<id>-credentials.json` and the test starts depending on the
    // developer's actual logins — which is exactly how it broke: a real
    // `pi-credentials.json` on the host produced an extra `pushFile`.
    backups = {
      claude: join(dir, 'claude-credentials.json'),
      codex: join(dir, 'codex-credentials.json'),
      opencode: join(dir, 'opencode-credentials.json'),
    };
    for (const spec of AGENT_SYNC_SPECS) {
      backups[spec.id] ??= join(dir, `${spec.id}-credentials.json`);
    }
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
      readText: (path) => (path === '/home/vscode/.codex/auth.json' ? '{"token":"box"}' : null),
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
