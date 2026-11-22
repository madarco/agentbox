import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SyncExecOptions, SyncExecResult } from '@agentbox/core';

// Scratch HOME before the imports: the default backup and the account store
// both resolve under it. Never the real ~/.agentbox.
const home = mkdtempSync(join(tmpdir(), 'agentbox-install-acct-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const { makeRecordingTransport } = await import('../src/sync/recording-transport.js');
const { ensureAgentInstalled } = await import('../src/sync/concerns/install.js');
const store = await import('../src/llm-accounts.js');

const OWNER = JSON.stringify({ claudeAiOauth: { refreshToken: 'OWNER-DEFAULT', expiresAt: 1 } });
const WORK = JSON.stringify({ claudeAiOauth: { refreshToken: 'ACCOUNT-WORK', expiresAt: 2 } });

beforeAll(async () => {
  mkdirSync(join(home, '.agentbox'), { recursive: true });
  writeFileSync(join(home, '.agentbox', 'claude-credentials.json'), OWNER);
  await store.upsertAccount({ agent: 'claude', id: 'work', kind: 'login', createdAt: 't' });
  await store.writeAccountSecret('claude', 'work', WORK);
  await store.upsertAccount({ agent: 'claude', id: 'ci', kind: 'setup-token', createdAt: 't' });
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const ok: SyncExecResult = { exitCode: 0, stdout: '', stderr: '' };
/** The probe misses once (needs installing); everything after succeeds. */
function missingThenOk(): (cmd: string[], o?: SyncExecOptions) => SyncExecResult {
  let first = true;
  return (cmd) => {
    if (cmd.join(' ').includes('command -v') && first) {
      first = false;
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    }
    return ok;
  };
}

/** Every recorded op plus the CONTENT of every pushed file (temp files are deleted). */
async function install(account?: string): Promise<string> {
  const t = makeRecordingTransport({ execResult: missingThenOk() });
  const pushed: string[] = [];
  const orig = t.pushFile.bind(t);
  t.pushFile = async (src: string, dest: string) => {
    pushed.push(readFileSync(src, 'utf8'));
    return orig(src, dest);
  };
  await ensureAgentInstalled(t, 'claude', account ? { account } : {});
  return JSON.stringify(t.ops) + pushed.join('\n');
}

describe('ensureAgentInstalled seeds the box account, never the owner default (#437-2)', () => {
  it('default account: the owner login, as before', async () => {
    const ops = await install();
    expect(ops).toContain('OWNER-DEFAULT');
  });

  it('a named login gets its own secret', async () => {
    const ops = await install('work');
    expect(ops).toContain('ACCOUNT-WORK');
    expect(ops).not.toContain('OWNER-DEFAULT');
  });

  it('a pasted account gets no login file, and any stale one is removed', async () => {
    const ops = await install('ci');
    expect(ops).not.toContain('OWNER-DEFAULT');
    expect(ops).toContain('rm -f');
    expect(ops).toContain('/home/vscode/.claude/.credentials.json');
  });
});
