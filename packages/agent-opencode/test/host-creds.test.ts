import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Moved here with the code. The CLI's version mocked
 * `@agentbox/agent-opencode`, which worked only while the IMPORTER was outside
 * the package — `cli/host-creds.ts` now reaches its sibling
 * `../docker-sync.js` directly, and only a test inside the package can
 * intercept that.
 */
const volumeHasOpencodeAuth = vi.fn<(volume: string, image: string) => Promise<boolean>>();
vi.mock('../src/docker-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker-sync.js')>()),
  volumeHasOpencodeAuth,
}));

const { opencodeAuthAvailable } = await import('../src/cli/host-creds.js');

const IMAGE = 'test-image:latest';

describe('opencodeAuthAvailable', () => {
  let homeDir: string;
  const origHome = process.env['HOME'];

  beforeEach(async () => {
    volumeHasOpencodeAuth.mockReset();
    homeDir = await mkdtemp(join(tmpdir(), 'agentbox-opencode-creds-'));
    process.env['HOME'] = homeDir;
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = origHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns true when any forwarded env key is set', async () => {
    volumeHasOpencodeAuth.mockResolvedValue(false);
    expect(await opencodeAuthAvailable(IMAGE, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
    expect(volumeHasOpencodeAuth).not.toHaveBeenCalled();
  });

  it('returns true when host auth.json exists', async () => {
    volumeHasOpencodeAuth.mockResolvedValue(false);
    await mkdir(join(homeDir, '.local', 'share', 'opencode'), { recursive: true });
    await writeFile(join(homeDir, '.local', 'share', 'opencode', 'auth.json'), '{}', 'utf8');
    expect(await opencodeAuthAvailable(IMAGE, {})).toBe(true);
  });

  it('falls back to the shared opencode-config volume probe', async () => {
    volumeHasOpencodeAuth.mockResolvedValue(true);
    expect(await opencodeAuthAvailable(IMAGE, {})).toBe(true);
    expect(volumeHasOpencodeAuth).toHaveBeenCalledWith('agentbox-opencode-config', IMAGE);
  });

  it('returns false when every source is empty', async () => {
    volumeHasOpencodeAuth.mockResolvedValue(false);
    expect(await opencodeAuthAvailable(IMAGE, {})).toBe(false);
  });
});
