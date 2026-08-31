import { mkdtemp, rm } from 'node:fs/promises';
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
  imageExists: vi.fn<(image: string) => Promise<boolean>>(),
  volumeHasCodexAuth: vi.fn<(volume: string, image: string) => Promise<boolean>>(),
  volumeHasOpencodeAuth: vi.fn<(volume: string, image: string) => Promise<boolean>>(),
}));

vi.mock('@agentbox/sandbox-docker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentbox/sandbox-docker')>();
  return {
    ...actual,
    hostBackupHasCredentials: sandboxDockerMock.hostBackupHasCredentials,
    imageExists: sandboxDockerMock.imageExists,
  };
});

// codex's volume probe moved with codex into `@agentbox/agent-codex`; the mock
// has to follow the symbol, not the package it used to be re-exported from.
vi.mock('@agentbox/agent-codex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentbox/agent-codex')>()),
  volumeHasCodexAuth: sandboxDockerMock.volumeHasCodexAuth,
}));

vi.mock('@agentbox/agent-opencode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentbox/agent-opencode')>()),
  volumeHasOpencodeAuth: sandboxDockerMock.volumeHasOpencodeAuth,
}));

const { assertAgentCredsAvailable, MissingAgentCredsError, ExpiredAgentCredsError } =
  await import('../src/lib/queue/assert-creds.js');
// The per-agent checks moved next to their runtimes — the shared helper no
// longer knows any agent's name. The mock has to follow the symbol.
const { claudeAuthAvailable, claudeCredStatus } = await import('@agentbox/agent-claude/cli');
const { claudeRuntime } = await import('@agentbox/agent-claude/cli');
const { codexRuntime } = await import('@agentbox/agent-codex/cli');
const { opencodeRuntime } = await import('@agentbox/agent-opencode/cli');

/** The agent supplies its own check now, so every assert call carries one. */
const RUNTIMES: Record<string, { hostCredStatus: (typeof claudeRuntime)['hostCredStatus'] }> = {
  'claude-code': claudeRuntime,
  codex: codexRuntime,
  opencode: opencodeRuntime,
};
// `hostClaudeLoginDead`, `hostClaudeAccessTokenExpired` and
// `renewClaudeCredential` live in `@agentbox/agent-claude` now — they only mean
// anything for a claude-oauth blob. They were mockable before only because they
// crossed a package boundary; inside their own package that stops working, so
// `resolveClaudeCredHealth` takes them as an explicit `probes` seam and these
// tests hand it stubs instead of depending on where a symbol is re-exported.
const probeMock = vi.hoisted(() => ({
  hostBackupHasCredentials: vi.fn<() => Promise<boolean>>(),
  accessTokenExpired: vi.fn<() => Promise<boolean>>(),
  loginDead: vi.fn<() => Promise<boolean>>(),
  imageExists: vi.fn<(image: string) => Promise<boolean>>(),
  renew: vi.fn<() => Promise<'renewed' | 'unchanged' | 'failed'>>(),
}));

function resetProbes(): void {
  for (const fn of Object.values(probeMock)) fn.mockReset();
  probeMock.loginDead.mockResolvedValue(false);
  probeMock.imageExists.mockResolvedValue(true);
}

function assertFor(input: {
  agent: string;
  image: string;
  env?: NodeJS.ProcessEnv;
  providerName?: string;
}) {
  return assertAgentCredsAvailable({
    ...input,
    hostCredStatus: async (o) => {
      if (input.agent !== 'claude-code') return RUNTIMES[input.agent]!.hostCredStatus(o);
      // Claude's runtime maps its three-way status onto the verdict; mirror that
      // here so the stubs reach `claudeCredStatus` while the dispatcher still
      // sees exactly the shape a runtime returns.
      const status = await claudeCredStatus(o.env, o.isCloud, o.image, probeMock);
      if (status === 'ok') return { status: 'ok' };
      if (status === 'missing') return { status: 'missing' };
      return {
        status: 'expired',
        message:
          'Your saved Claude login can no longer be renewed. Sign in again with `agentbox claude login`, then retry.',
      };
    },
  } as Parameters<typeof assertAgentCredsAvailable>[0]);
}

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

describe('claudeCredStatus', () => {
  beforeEach(resetProbes);

  it('is "missing" when no env and no backup', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(false);
    expect(await claudeCredStatus({}, true, IMAGE, probeMock)).toBe('missing');
  });

  it('is "ok" when a host-env token is set (health not consulted)', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(false);
    probeMock.loginDead.mockResolvedValue(true);
    expect(await claudeCredStatus({ ANTHROPIC_API_KEY: 'sk-test' }, true, IMAGE, probeMock)).toBe(
      'ok',
    );
    expect(probeMock.loginDead).not.toHaveBeenCalled();
  });

  it('is "expired" on cloud only when the login can no longer be renewed', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(true);
    probeMock.loginDead.mockResolvedValue(true);
    expect(await claudeCredStatus({}, true, IMAGE, probeMock)).toBe('expired');
  });

  // The false positive this whole change exists for: access tokens live ~8h, so
  // gating on `expiresAt` failed perfectly good jobs every single day.
  it('is "ok" on cloud when a lapsed access token renews', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(true);
    probeMock.accessTokenExpired.mockResolvedValue(true);
    probeMock.renew.mockResolvedValue('renewed');
    expect(await claudeCredStatus({}, true, IMAGE, probeMock)).toBe('ok');
    expect(probeMock.renew).toHaveBeenCalled();
  });

  it('is "expired" on cloud when the renewal itself fails (rotated away)', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(true);
    probeMock.accessTokenExpired.mockResolvedValue(true);
    probeMock.renew.mockResolvedValue('failed');
    expect(await claudeCredStatus({}, true, IMAGE, probeMock)).toBe('expired');
  });

  it('is "ok" on cloud without renewing when the access token is still valid', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(true);
    probeMock.accessTokenExpired.mockResolvedValue(false);
    expect(await claudeCredStatus({}, true, IMAGE, probeMock)).toBe('ok');
    expect(probeMock.renew).not.toHaveBeenCalled();
  });

  it('is "ok" on cloud when the image is not local — never pull just to answer', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(true);
    probeMock.accessTokenExpired.mockResolvedValue(true);
    probeMock.imageExists.mockResolvedValue(false);
    expect(await claudeCredStatus({}, true, IMAGE, probeMock)).toBe('ok');
    expect(probeMock.renew).not.toHaveBeenCalled();
  });

  it('is "ok" on docker whatever the token looks like (the box boots from the volume)', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(true);
    probeMock.loginDead.mockResolvedValue(true);
    expect(await claudeCredStatus({}, false, IMAGE, probeMock)).toBe('ok');
    // No health probe at all when the provider is docker.
    expect(probeMock.loginDead).not.toHaveBeenCalled();
    expect(probeMock.renew).not.toHaveBeenCalled();
  });
});

describe('assertAgentCredsAvailable dispatcher', () => {
  let homeDir: string;
  const origHome = process.env['HOME'];

  beforeEach(async () => {
    resetProbes();
    sandboxDockerMock.hostBackupHasCredentials.mockReset();
    sandboxDockerMock.imageExists.mockReset();
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
    probeMock.hostBackupHasCredentials.mockResolvedValue(true);
    await expect(
      assertFor({ agent: 'claude-code', image: IMAGE, env: {} }),
    ).resolves.toBeUndefined();
  });

  it('throws MissingAgentCredsError for claude when no source has creds', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(false);
    await expect(assertFor({ agent: 'claude-code', image: IMAGE, env: {} })).rejects.toBeInstanceOf(
      MissingAgentCredsError,
    );
  });

  it('throws ExpiredAgentCredsError for claude on cloud when the login cannot be renewed', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(true);
    probeMock.loginDead.mockResolvedValue(true);
    try {
      await assertFor({
        agent: 'claude-code',
        image: IMAGE,
        env: {},
        providerName: 'daytona',
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ExpiredAgentCredsError);
      // The expired subclass must still satisfy the existing catch at the call sites.
      expect(err).toBeInstanceOf(MissingAgentCredsError);
      const e = err as InstanceType<typeof ExpiredAgentCredsError>;
      expect(e.message).toContain('renewed');
      expect(e.message).toContain('agentbox claude login');
    }
  });

  it('does NOT throw for claude on docker when the login looks dead', async () => {
    probeMock.hostBackupHasCredentials.mockResolvedValue(true);
    probeMock.loginDead.mockResolvedValue(true);
    await expect(
      assertFor({
        agent: 'claude-code',
        image: IMAGE,
        env: {},
        providerName: 'docker',
      }),
    ).resolves.toBeUndefined();
  });

  it('error carries the agent kind and a helpful message', async () => {
    sandboxDockerMock.volumeHasCodexAuth.mockResolvedValue(false);
    try {
      await assertFor({ agent: 'codex', image: IMAGE, env: {} });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingAgentCredsError);
      const e = err as InstanceType<typeof MissingAgentCredsError>;
      expect(e.agent).toBe('codex');
      expect(e.message).toContain('agentbox codex login');
      expect(e.message).toContain('OPENAI_API_KEY');
    }
  });
});

describe('assertAgentCredsAvailable dispatch', () => {
  it("uses the AGENT's own check, so a fourth agent is never given another's", async () => {
    // The removed three-arm chain was `agent === 'codex' ? codex : opencode`,
    // so any agent that was not claude or codex silently got OpenCode's
    // credential check — a wrong answer with nothing failing.
    let sawImage: string | undefined;
    await expect(
      assertAgentCredsAvailable({
        agent: 'demo' as never,
        image: 'demo-image',
        env: {},
        hostCredStatus: ({ image }) => {
          sawImage = image;
          return Promise.resolve({ status: 'ok' as const });
        },
      }),
    ).resolves.toBeUndefined();
    expect(sawImage).toBe('demo-image');
  });

  it('reports a missing credential for an agent it has never heard of', async () => {
    await expect(
      assertAgentCredsAvailable({
        agent: 'demo' as never,
        image: 'demo-image',
        env: {},
        hostCredStatus: () => Promise.resolve({ status: 'missing' as const }),
      }),
    ).rejects.toThrow(/No demo credentials on host/);
  });

  it('passes isCloud through, since only the agent knows what to do with it', async () => {
    const seen: boolean[] = [];
    const probe = (providerName?: string) =>
      assertAgentCredsAvailable({
        agent: 'demo' as never,
        image: 'i',
        env: {},
        ...(providerName === undefined ? {} : { providerName }),
        hostCredStatus: ({ isCloud }) => {
          seen.push(isCloud);
          return Promise.resolve({ status: 'ok' as const });
        },
      });
    await probe('daytona');
    await probe('docker');
    await probe();
    expect(seen).toEqual([true, false, false]);
  });

  it("surfaces the agent's own wording for an unrenewable login", async () => {
    // The expired message used to be a claude constant in the shared helper.
    await expect(
      assertAgentCredsAvailable({
        agent: 'demo' as never,
        image: 'i',
        env: {},
        hostCredStatus: () =>
          Promise.resolve({ status: 'expired' as const, message: 'demo says: re-auth' }),
      }),
    ).rejects.toThrow('demo says: re-auth');
  });
});
