import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * This lived in `apps/cli/test/assert-creds.test.ts` while `codexAuthAvailable`
 * lived in the CLI. It moved with the code, and it had to: the CLI's version
 * mocked `@agentbox/agent-codex`, which worked only while the IMPORTER was
 * outside the package. Now the importer is `cli/host-creds.ts` reaching its
 * sibling `../docker-sync.js` directly, and only a test inside the package can
 * intercept that.
 */
const volumeHasCodexAuth = vi.fn<(volume: string, image: string) => Promise<boolean>>();
vi.mock('../src/docker-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker-sync.js')>()),
  volumeHasCodexAuth,
}));

const { codexAuthAvailable } = await import('../src/cli/host-creds.js');

const IMAGE = 'test-image:latest';

describe('codexAuthAvailable', () => {
  let homeDir: string;
  const origHome = process.env['HOME'];

  beforeEach(async () => {
    volumeHasCodexAuth.mockReset();
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
    volumeHasCodexAuth.mockResolvedValue(false);
    expect(await codexAuthAvailable(IMAGE, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
    expect(volumeHasCodexAuth).not.toHaveBeenCalled();
  });

  it('returns true when ~/.codex/auth.json exists', async () => {
    volumeHasCodexAuth.mockResolvedValue(false);
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(join(homeDir, '.codex', 'auth.json'), '{}', 'utf8');
    expect(await codexAuthAvailable(IMAGE, {})).toBe(true);
  });

  it('falls back to the shared codex-config volume probe', async () => {
    volumeHasCodexAuth.mockResolvedValue(true);
    expect(await codexAuthAvailable(IMAGE, {})).toBe(true);
    expect(volumeHasCodexAuth).toHaveBeenCalledWith('agentbox-codex-config', IMAGE);
  });

  it('returns false when every source is empty', async () => {
    volumeHasCodexAuth.mockResolvedValue(false);
    expect(await codexAuthAvailable(IMAGE, {})).toBe(false);
  });
});

describe('stageCodexCredentialsForUpload', () => {
  /**
   * Moved out of `sandbox-cloud`'s seeding test with the stager itself. What it
   * asserts is CODEX's behaviour — the macOS Keychain landmine, where the
   * config exists but `auth.json` never will because the token lives in the
   * Keychain — not anything about how a cloud box is seeded.
   */
  it('warns rather than failing when ~/.codex exists but auth.json does not', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbox-codex-keychain-'));
    try {
      await mkdir(join(home, '.codex'), { recursive: true });
      await writeFile(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
      // intentionally NO auth.json
      const { stageCodexCredentialsForUpload } = await import('../src/host-stage.js');
      const res = await stageCodexCredentialsForUpload({ hostHome: home });
      expect(res.tarballPath).toBeNull();
      expect(res.warnings.join(' ')).toMatch(/Keychain/i);
      await res.cleanup();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
