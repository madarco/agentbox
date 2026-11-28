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
      if (script.includes('/src/projects/ /dst/')) migrations.push(argv);
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
  it('copies a shared or named volume on every create (rsync --update), never an isolated one', async () => {
    migrations = [];
    for (const volume of [
      'agentbox-claude-config-acct-other',
      'agentbox-claude-config-acct-other',
      'agentbox-claude-config-b1234abcd',
    ]) {
      await ensureClaudeVolume({ volume }, { syncFromHost: false, image: 'img' });
    }
    // Twice: a pre-upgrade box keeps appending to the config volume's own dir.
    expect(migrations).toHaveLength(2);
    const argv = migrations[0]!;
    expect(argv).toContain('agentbox-claude-projects:/dst');
    expect(argv).toContain('agentbox-claude-config-acct-other:/src:ro');
    // A newer source (an appended transcript) wins; a newer shared copy stays.
    expect(argv.join(' ')).toContain('rsync -a --update --chown=1000:1000');
    expect(argv.join(' ')).toContain('chown 1000:1000 /dst');
  });

  it('a failed copy fails the create', async () => {
    execaMock.mockImplementation((_cmd: string, argv: string[]) =>
      Promise.resolve(
        argv.join(' ').includes('/src/projects/ /dst/')
          ? { exitCode: 1, stdout: '', stderr: 'rsync: boom' }
          : { exitCode: 0, stdout: '', stderr: '' },
      ),
    );
    await expect(
      ensureClaudeVolume(
        { volume: 'agentbox-claude-config' },
        { syncFromHost: false, image: 'img' },
      ),
    ).rejects.toThrow(/agentbox-claude-projects.*rsync: boom/);
  });

  it('skips the legacy memory rekey into a volume whose projects/ is hidden', async () => {
    await ensureClaudeVolume(
      { volume: 'agentbox-claude-config' },
      { syncFromHost: true, image: 'img', hostWorkspace: '/w/proj' },
    );
    expect(seedScript).not.toContain('/dst/projects/-workspace/memory');
    await ensureClaudeVolume(
      { volume: 'agentbox-claude-config-b1234abcd' },
      { syncFromHost: true, image: 'img', hostWorkspace: '/w/proj' },
    );
    expect(seedScript).toContain('/dst/projects/-workspace/memory');
  });

  it('mounts it over ~/.claude/projects for the default and named volumes only', () => {
    const mount = 'agentbox-claude-projects:/home/vscode/.claude/projects';
    expect(buildClaudeMounts({ volume: 'agentbox-claude-config' }, {}).extraVolumes).toContain(
      mount,
    );
    expect(
      buildClaudeMounts({ volume: 'agentbox-claude-config-acct-other' }, {}).extraVolumes,
    ).toContain(mount);
    expect(
      buildClaudeMounts({ volume: 'agentbox-claude-config-b1234abcd' }, {}).extraVolumes,
    ).not.toContain(mount);
    expect(usesSharedProjects('agentbox-claude-config-b1234abcd')).toBe(false);
  });
});
