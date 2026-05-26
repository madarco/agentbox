import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Module mocks must be declared before importing the unit under test. We swap
// out the cross-package symbols that read real host state (the OAuth backup
// file, the volume-probe docker exec) so the tests are pure. Everything else
// is forwarded from the real module via `importOriginal` (notably `STATE_DIR`,
// which `apps/cli/src/auth.ts` reads at load time).
const sandboxDockerMock = vi.hoisted(() => ({
  hostBackupHasCredentials: vi.fn<() => Promise<boolean>>(),
  volumeHasCodexAuth: vi.fn<(volume: string, image: string) => Promise<boolean>>(),
  volumeHasOpencodeAuth: vi.fn<(volume: string, image: string) => Promise<boolean>>(),
}));

vi.mock('@agentbox/sandbox-docker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentbox/sandbox-docker')>();
  return {
    ...actual,
    hostBackupHasCredentials: sandboxDockerMock.hostBackupHasCredentials,
    volumeHasCodexAuth: sandboxDockerMock.volumeHasCodexAuth,
    volumeHasOpencodeAuth: sandboxDockerMock.volumeHasOpencodeAuth,
  };
});

const {
  assertAgentCredsAvailable,
  claudeAuthAvailable,
  codexAuthAvailable,
  opencodeAuthAvailable,
  MissingAgentCredsError,
} = await import('../src/lib/queue/assert-creds.js');

// Re-import the auth file path AFTER the mock; the module reads STATE_DIR from
// the mocked sandbox-docker, but resolveClaudeAuth pulls it through readAuthFile
// which we control by passing `authFilePath` from assert-creds (it doesn't —
// resolveClaudeAuth uses a default). We rely on the env-only and backup paths
// here; the auth-file legacy path is already covered by auth.test.ts.

const IMAGE = 'test-image:latest';

describe('claudeAuthAvailable', () => {
  beforeEach(() => {
    sandboxDockerMock.hostBackupHasCredentials.mockReset();
  });

  it('returns true when ANTHROPIC_API_KEY is set in env', async () => {
    sandboxDockerMock.hostBackupHasCredentials.mockResolvedValue(false);
    expect(await claudeAuthAvailable({ ANTHROPIC_API_KEY: 'sk-test' })).toBe(true);
    // backup probe must NOT be called when env already satisfies (short-circuit).
    expect(sandboxDockerMock.hostBackupHasCredentials).not.toHaveBeenCalled();
  });

  it('returns true when CLAUDE_CODE_OAUTH_TOKEN is set in env', async () => {
    sandboxDockerMock.hostBackupHasCredentials.mockResolvedValue(false);
    expect(await claudeAuthAvailable({ CLAUDE_CODE_OAUTH_TOKEN: 'oat-x' })).toBe(true);
  });

  it('falls back to host backup when no env vars are set', async () => {
    sandboxDockerMock.hostBackupHasCredentials.mockResolvedValue(true);
    expect(await claudeAuthAvailable({})).toBe(true);
    expect(sandboxDockerMock.hostBackupHasCredentials).toHaveBeenCalledOnce();
  });

  it('returns false when env empty and backup absent', async () => {
    sandboxDockerMock.hostBackupHasCredentials.mockResolvedValue(false);
    expect(await claudeAuthAvailable({})).toBe(false);
  });
});

describe('codexAuthAvailable', () => {
  let homeDir: string;
  const origHome = process.env['HOME'];

  beforeEach(async () => {
    sandboxDockerMock.volumeHasCodexAuth.mockReset();
    // Redirect homedir() to a tmpdir so the file probe is deterministic and
    // doesn't see the developer's real ~/.codex/auth.json.
    homeDir = await mkdtemp(join(tmpdir(), 'agentbox-codex-creds-'));
    process.env['HOME'] = homeDir;
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = origHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns true when OPENAI_API_KEY is set', async () => {
    sandboxDockerMock.volumeHasCodexAuth.mockResolvedValue(false);
    expect(await codexAuthAvailable(IMAGE, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
    expect(sandboxDockerMock.volumeHasCodexAuth).not.toHaveBeenCalled();
  });

  it('returns true when ~/.codex/auth.json exists', async () => {
    sandboxDockerMock.volumeHasCodexAuth.mockResolvedValue(false);
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(join(homeDir, '.codex', 'auth.json'), '{}', 'utf8');
    expect(await codexAuthAvailable(IMAGE, {})).toBe(true);
  });

  it('falls back to the shared codex-config volume probe', async () => {
    sandboxDockerMock.volumeHasCodexAuth.mockResolvedValue(true);
    expect(await codexAuthAvailable(IMAGE, {})).toBe(true);
    expect(sandboxDockerMock.volumeHasCodexAuth).toHaveBeenCalledWith(
      'agentbox-codex-config',
      IMAGE,
    );
  });

  it('returns false when every source is empty', async () => {
    sandboxDockerMock.volumeHasCodexAuth.mockResolvedValue(false);
    expect(await codexAuthAvailable(IMAGE, {})).toBe(false);
  });
});

describe('opencodeAuthAvailable', () => {
  let homeDir: string;
  const origHome = process.env['HOME'];

  beforeEach(async () => {
    sandboxDockerMock.volumeHasOpencodeAuth.mockReset();
    homeDir = await mkdtemp(join(tmpdir(), 'agentbox-opencode-creds-'));
    process.env['HOME'] = homeDir;
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = origHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns true when any forwarded env key is set', async () => {
    sandboxDockerMock.volumeHasOpencodeAuth.mockResolvedValue(false);
    expect(await opencodeAuthAvailable(IMAGE, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
    expect(sandboxDockerMock.volumeHasOpencodeAuth).not.toHaveBeenCalled();
  });

  it('returns true when host auth.json exists', async () => {
    sandboxDockerMock.volumeHasOpencodeAuth.mockResolvedValue(false);
    await mkdir(join(homeDir, '.local', 'share', 'opencode'), { recursive: true });
    await writeFile(
      join(homeDir, '.local', 'share', 'opencode', 'auth.json'),
      '{}',
      'utf8',
    );
    expect(await opencodeAuthAvailable(IMAGE, {})).toBe(true);
  });

  it('falls back to the shared opencode-config volume probe', async () => {
    sandboxDockerMock.volumeHasOpencodeAuth.mockResolvedValue(true);
    expect(await opencodeAuthAvailable(IMAGE, {})).toBe(true);
    expect(sandboxDockerMock.volumeHasOpencodeAuth).toHaveBeenCalledWith(
      'agentbox-opencode-config',
      IMAGE,
    );
  });

  it('returns false when every source is empty', async () => {
    sandboxDockerMock.volumeHasOpencodeAuth.mockResolvedValue(false);
    expect(await opencodeAuthAvailable(IMAGE, {})).toBe(false);
  });
});

describe('assertAgentCredsAvailable dispatcher', () => {
  let homeDir: string;
  const origHome = process.env['HOME'];

  beforeEach(async () => {
    sandboxDockerMock.hostBackupHasCredentials.mockReset();
    sandboxDockerMock.volumeHasCodexAuth.mockReset();
    sandboxDockerMock.volumeHasOpencodeAuth.mockReset();
    homeDir = await mkdtemp(join(tmpdir(), 'agentbox-dispatch-creds-'));
    process.env['HOME'] = homeDir;
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = origHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns silently when claude has creds', async () => {
    sandboxDockerMock.hostBackupHasCredentials.mockResolvedValue(true);
    await expect(
      assertAgentCredsAvailable({ agent: 'claude-code', image: IMAGE, env: {} }),
    ).resolves.toBeUndefined();
  });

  it('throws MissingAgentCredsError for claude when no source has creds', async () => {
    sandboxDockerMock.hostBackupHasCredentials.mockResolvedValue(false);
    await expect(
      assertAgentCredsAvailable({ agent: 'claude-code', image: IMAGE, env: {} }),
    ).rejects.toBeInstanceOf(MissingAgentCredsError);
  });

  it('error carries the agent kind and a helpful message', async () => {
    sandboxDockerMock.volumeHasCodexAuth.mockResolvedValue(false);
    try {
      await assertAgentCredsAvailable({ agent: 'codex', image: IMAGE, env: {} });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingAgentCredsError);
      const e = err as InstanceType<typeof MissingAgentCredsError>;
      expect(e.agent).toBe('codex');
      expect(e.message).toContain('agentbox codex login');
      expect(e.message).toContain('OPENAI_API_KEY');
    }
  });

  it('routes opencode through the opencode predicate', async () => {
    sandboxDockerMock.volumeHasOpencodeAuth.mockResolvedValue(true);
    await expect(
      assertAgentCredsAvailable({ agent: 'opencode', image: IMAGE, env: {} }),
    ).resolves.toBeUndefined();
    // Wrong-agent predicates must not be consulted.
    expect(sandboxDockerMock.hostBackupHasCredentials).not.toHaveBeenCalled();
    expect(sandboxDockerMock.volumeHasCodexAuth).not.toHaveBeenCalled();
  });
});
