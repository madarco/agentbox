import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { syncMock } = vi.hoisted(() => ({ syncMock: vi.fn() }));
vi.mock('@agentbox/sandbox-docker', async (orig) => ({
  ...(await orig<typeof import('@agentbox/sandbox-docker')>()),
  syncClaudeCredentials: syncMock,
}));

// Scratch HOME: the account store and STATE_DIR resolve under it.
const home = mkdtempSync(join(tmpdir(), 'agentbox-boxcred-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const { syncBoxClaudeCredentials } = await import('../src/cli/box-credentials.js');
const core = await import('@agentbox/sandbox-core');

beforeAll(async () => {
  await core.upsertAccount({ agent: 'claude', id: 'work', kind: 'login', createdAt: 't' });
  await core.upsertAccount({ agent: 'claude', id: 'ci', kind: 'setup-token', createdAt: 't' });
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  syncMock.mockReset();
  syncMock.mockResolvedValue({ direction: 'noop', volumeHasCredentials: true });
});

describe('syncBoxClaudeCredentials (llm-accounts Phase 3)', () => {
  it('a default box mirrors with the legacy backup, as before', async () => {
    await syncBoxClaudeCredentials({ image: 'img' }, 'agentbox-claude-config');
    expect(syncMock).toHaveBeenCalledWith(
      { volume: 'agentbox-claude-config' },
      { image: 'img', isolate: false },
    );
  });

  it('a named box mirrors only its own volume, with its own secret', async () => {
    await syncBoxClaudeCredentials(
      { image: 'img', accounts: { claude: 'work' } },
      'agentbox-claude-config-acct-work',
    );
    expect(syncMock).toHaveBeenCalledWith(
      { volume: 'agentbox-claude-config-acct-work' },
      { image: 'img', isolate: false, hostBackupRel: 'credentials/claude/work.json' },
    );
  });

  it('a named box never mirrors against the shared volume (review blocking fix)', async () => {
    await syncBoxClaudeCredentials(
      { image: 'img', accounts: { claude: 'work' } },
      'agentbox-claude-config',
    );
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('a pasted account has no login to mirror', async () => {
    await syncBoxClaudeCredentials(
      { image: 'img', accounts: { claude: 'ci' } },
      'agentbox-claude-config-acct-ci',
    );
    expect(syncMock).not.toHaveBeenCalled();
  });
});
