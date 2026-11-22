import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

// A scratch HOME: the seed reads ~/.claude and ~/.claude.json, never the real ones.
const home = mkdtempSync(join(tmpdir(), 'agentbox-seed-home-'));
const realHome = process.env.HOME;
process.env.HOME = home;
mkdirSync(join(home, '.claude'), { recursive: true });
writeFileSync(join(home, '.claude', 'settings.json'), '{}');
writeFileSync(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"r"}}');
writeFileSync(
  join(home, '.claude.json'),
  JSON.stringify({
    installMethod: 'native',
    oauthAccount: { emailAddress: 'owner@example.com' },
    customApiKeyResponses: { approved: ['x'] },
  }),
);

const { ensureClaudeVolume } = await import('../src/docker-sync.js');

let overlay: Record<string, unknown> | null;
let seedScript = '';

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  overlay = null;
  seedScript = '';
  execaMock.mockReset();
  execaMock.mockImplementation((_cmd: string, argv: string[]) => {
    // `test -e /dst/_claude.json`: the volume has none yet, so it gets seeded.
    if (argv.includes('test -e /dst/_claude.json')) return Promise.resolve({ exitCode: 1 });
    const filter = argv.find((a) => a.endsWith(':/src-filter:ro'));
    if (filter) {
      try {
        overlay = JSON.parse(
          readFileSync(join(filter.split(':')[0]!, '_claude.json'), 'utf8'),
        ) as Record<string, unknown>;
      } catch {
        overlay = null;
      }
    }
    const sh = argv.indexOf('-c');
    if (sh !== -1 && argv[sh - 1] === 'sh') seedScript = argv[sh + 1] ?? '';
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  });
});

describe('seeding a named account volume (llm-accounts Phase 2)', () => {
  it("excludes the host's login and strips the host's account state", async () => {
    await ensureClaudeVolume(
      { volume: 'agentbox-claude-config-acct-work' },
      { syncFromHost: true, image: 'img', account: 'work' },
    );
    expect(seedScript).toContain('--exclude=/.credentials.json');
    expect(overlay).not.toBeNull();
    expect(overlay).not.toHaveProperty('oauthAccount');
    expect(overlay).not.toHaveProperty('customApiKeyResponses');
    expect(overlay).toHaveProperty('installMethod', 'native');
  });

  it('the default volume keeps the login and the host state (unchanged behaviour)', async () => {
    await ensureClaudeVolume(
      { volume: 'agentbox-claude-config' },
      { syncFromHost: true, image: 'img' },
    );
    expect(seedScript).not.toContain('--exclude=/.credentials.json');
    // The raw host file is copied; an overlay, if any, keeps oauthAccount.
    if (overlay) expect(overlay).toHaveProperty('oauthAccount');
  });
});
