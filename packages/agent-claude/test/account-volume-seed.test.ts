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
writeFileSync(
  join(home, '.claude', 'settings.json'),
  JSON.stringify({ model: 'opus', env: { ANTHROPIC_API_KEY: 'owner-key', FOO: 'bar' } }),
);
writeFileSync(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"r"}}');
writeFileSync(
  join(home, '.claude.json'),
  JSON.stringify({
    installMethod: 'native',
    oauthAccount: { emailAddress: 'owner@example.com' },
    customApiKeyResponses: { approved: ['x'] },
  }),
);

const { buildClaudeMounts, ensureClaudeVolume, usesSharedProjects } =
  await import('../src/docker-sync.js');

let overlay: Record<string, unknown> | null;
let settingsOverlay: Record<string, unknown> | null;
let seedScript = '';

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  overlay = null;
  settingsOverlay = null;
  seedScript = '';
  migrations = [];
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
      try {
        settingsOverlay = JSON.parse(
          readFileSync(join(filter.split(':')[0]!, 'settings.json'), 'utf8'),
        ) as Record<string, unknown>;
      } catch {
        settingsOverlay = null;
      }
    }
    const sh = argv.indexOf('-c');
    if (sh !== -1 && argv[sh - 1] === 'sh') {
      const script = argv[sh + 1] ?? '';
      // The shared-projects migration runs after the seed; keep the seed's.
      if (script.includes('.agentbox-migrated-')) migrations.push(argv);
      else seedScript = script;
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  });
});

let migrations: string[][] = [];

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
    // The owner's API key must not ride settings.json into the account's volume.
    expect(settingsOverlay).toEqual({ model: 'opus', env: { FOO: 'bar' } });
  });

  it('the default volume keeps the login and the host state (unchanged behaviour)', async () => {
    await ensureClaudeVolume(
      { volume: 'agentbox-claude-config' },
      { syncFromHost: true, image: 'img' },
    );
    expect(seedScript).not.toContain('--exclude=/.credentials.json');
    // Whatever _claude.json lands in the volume is marked onboarded.
    expect(seedScript).toContain('jq ".hasCompletedOnboarding = true"');
    // The raw host file is copied; an overlay, if any, keeps oauthAccount.
    if (overlay) expect(overlay).toHaveProperty('oauthAccount');
    // Default volume: settings are unchanged (no overlay written for them).
    expect(settingsOverlay).toBeNull();
  });
});

describe('the shared projects volume (--resume across accounts)', () => {
  it('migrates a shared or named volume once into agentbox-claude-projects, never an isolated one', async () => {
    await ensureClaudeVolume(
      { volume: 'agentbox-claude-config-acct-work' },
      { syncFromHost: false, image: 'img' },
    );
    await ensureClaudeVolume(
      { volume: 'agentbox-claude-config' },
      { syncFromHost: false, image: 'img' },
    );
    await ensureClaudeVolume(
      { volume: 'agentbox-claude-config-b1234abcd' },
      { syncFromHost: false, image: 'img' },
    );
    expect(migrations.map((a) => a[a.length - 1])).toEqual([
      'agentbox-claude-config-acct-work',
      'agentbox-claude-config',
    ]);
    expect(migrations[0]).toContain('agentbox-claude-projects:/dst');
    expect(migrations[0]).toContain('agentbox-claude-config-acct-work:/src:ro');
    // Never over a session already in the shared volume.
    expect(migrations[0]!.join(' ')).toContain('cp -a -n');
  });

  it('mounts it over ~/.claude/projects for the default and named volumes only', () => {
    const mount = 'agentbox-claude-projects:/home/vscode/.claude/projects';
    expect(buildClaudeMounts({ volume: 'agentbox-claude-config' }, {}).extraVolumes).toContain(
      mount,
    );
    expect(
      buildClaudeMounts({ volume: 'agentbox-claude-config-acct-work' }, {}).extraVolumes,
    ).toContain(mount);
    expect(
      buildClaudeMounts({ volume: 'agentbox-claude-config-b1234abcd' }, {}).extraVolumes,
    ).not.toContain(mount);
    expect(usesSharedProjects('agentbox-claude-config-b1234abcd')).toBe(false);
  });
});
