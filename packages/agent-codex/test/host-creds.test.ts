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
    expect(volumeHasCodexAuth).toHaveBeenCalledWith(
      'agentbox-codex-config',
      IMAGE,
    );
  });

  it('returns false when every source is empty', async () => {
    volumeHasCodexAuth.mockResolvedValue(false);
    expect(await codexAuthAvailable(IMAGE, {})).toBe(false);
  });
});
