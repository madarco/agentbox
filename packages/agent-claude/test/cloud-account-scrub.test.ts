import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudBackend, CloudHandle } from '@agentbox/core';

const home = mkdtempSync(join(tmpdir(), 'agentbox-cloud-scrub-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const { authSettingsJq, scrubCloudClaudeForAccount, scrubScript } =
  await import('../src/cloud-account-scrub.js');
const core = await import('@agentbox/sandbox-core');
const KEY = 'sk-ant-api03-' + 'k'.repeat(30) + 'LAST20CHARSOFTHEKEY!';

beforeAll(async () => {
  await core.upsertAccount({ agent: 'claude', id: 'work', kind: 'login', createdAt: 't' });
  await core.upsertAccount({ agent: 'claude', id: 'key', kind: 'api-key', createdAt: 't' });
  await core.writeAccountSecret(
    'claude',
    'key',
    core.encodePastedSecret({ kind: 'api-key', token: KEY }),
  );
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

function fakeBackend() {
  const execs: string[] = [];
  const uploads: string[] = [];
  const backend = {
    exec: (_h: CloudHandle, cmd: string) => {
      execs.push(cmd);
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
    uploadFile: (_h: CloudHandle, local: string) => {
      uploads.push(readFileSync(local, 'utf8'));
      return Promise.resolve();
    },
  } as unknown as CloudBackend;
  return { backend, execs, uploads };
}

describe('cloud named claude box: strip the owner identity (#437-3)', () => {
  it('the programs strip account state and settings auth', () => {
    expect(scrubScript()).toContain('.oauthAccount');
    expect(scrubScript()).toContain('.primaryApiKey');
    expect(authSettingsJq()).toContain('del(.apiKeyHelper)');
    expect(authSettingsJq()).toContain('.ANTHROPIC_API_KEY');
    expect(authSettingsJq()).toContain('.CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('a login account is scrubbed, with no key approval', async () => {
    const f = fakeBackend();
    await scrubCloudClaudeForAccount(f.backend, {} as CloudHandle, 'work', () => {});
    expect(f.execs).toHaveLength(1);
    expect(f.execs[0]).toContain('settings.json');
    expect(f.uploads).toEqual([]);
  });

  it('an api-key account is pre-approved; the suffix travels as a file, never on argv', async () => {
    const f = fakeBackend();
    await scrubCloudClaudeForAccount(f.backend, {} as CloudHandle, 'key', () => {});
    expect(f.uploads).toEqual([KEY.slice(-20)]);
    expect(f.execs.join('\n')).toContain('customApiKeyResponses.approved');
    expect(f.execs.join('\n')).not.toContain(KEY.slice(-20));
  });
});
