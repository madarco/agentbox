import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

// A scratch HOME with no ~/.claude: the host the e2e docker@linux target runs on.
const home = mkdtempSync(join(tmpdir(), 'agentbox-onboarding-home-'));
const realHome = process.env.HOME;
process.env.HOME = home;

const { ensureClaudeVolume } = await import('../src/docker-sync.js');
const { defaultBoxClaudeJson } = await import('../src/claude-json-defaults.js');

interface Call {
  argv: string[];
  input?: string;
}
let calls: Call[] = [];
let seedStdout = '';

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  seedStdout = '';
  execaMock.mockReset();
  execaMock.mockImplementation((_cmd: string, argv: string[], opts?: { input?: string }) => {
    calls.push({ argv, ...(opts?.input === undefined ? {} : { input: opts.input }) });
    const isSeed = argv.includes('sh') && opts?.input !== undefined;
    return Promise.resolve({ exitCode: 0, stdout: isSeed ? seedStdout : '', stderr: '' });
  });
});

function seedCall(): Call {
  const c = calls.find((x) => x.input !== undefined);
  if (!c) throw new Error('no seed helper ran');
  return c;
}

describe('ensureClaudeVolume with no host ~/.claude', () => {
  it('pipes the shared pre-onboarded default into a no-clobber write', async () => {
    seedStdout = 'seeded\n';
    const r = await ensureClaudeVolume(
      { volume: 'agentbox-claude-config' },
      { syncFromHost: true, image: 'img' },
    );
    expect(r).toMatchObject({ synced: false, onboardingSeeded: true, onboardingPatched: false });
    const c = seedCall();
    expect(JSON.parse(c.input ?? '')).toEqual(defaultBoxClaudeJson('/workspace'));
    const script = c.argv[c.argv.length - 1] ?? '';
    // Only written when absent, and via `ln`, which refuses to replace a file.
    expect(script).toContain('if [ ! -e /dst/_claude.json ]');
    expect(script).toContain('ln "$t" /dst/_claude.json');
    // An existing file only gets the onboarding flag merged in.
    expect(script).toContain('jq ".hasCompletedOnboarding = true"');
  });

  it('reports a patched existing file', async () => {
    seedStdout = 'patched\n';
    const r = await ensureClaudeVolume(
      { volume: 'agentbox-claude-config' },
      { syncFromHost: true, image: 'img' },
    );
    expect(r).toMatchObject({ onboardingSeeded: false, onboardingPatched: true });
  });

  it('reports nothing when the file was already onboarded', async () => {
    const r = await ensureClaudeVolume(
      { volume: 'agentbox-claude-config' },
      { syncFromHost: true, image: 'img' },
    );
    expect(r).toMatchObject({ onboardingSeeded: false, onboardingPatched: false });
  });

  it('throws when the helper fails', async () => {
    execaMock.mockImplementation((_c: string, _a: string[], opts?: { input?: string }) =>
      Promise.resolve(
        opts?.input !== undefined
          ? { exitCode: 1, stdout: '', stderr: 'boom' }
          : { exitCode: 0, stdout: '', stderr: '' },
      ),
    );
    await expect(
      ensureClaudeVolume(
        { volume: 'agentbox-claude-config' },
        { syncFromHost: true, image: 'img' },
      ),
    ).rejects.toThrow(/boom/);
  });

  it('does nothing without syncFromHost', async () => {
    await ensureClaudeVolume({ volume: 'v' }, { syncFromHost: false, image: 'img' });
    expect(calls.some((c) => c.input !== undefined)).toBe(false);
  });
});
