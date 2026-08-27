import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTempAgentboxHome } from '../../../scripts/test-home.js';

// Isolate HOME to a throwaway dir BEFORE @agentbox/config is ever loaded.
// `@agentbox/config` captures `STATE_DIR = join(homedir(), '.agentbox')` at
// module-eval time, and `os.homedir()` honours $HOME on POSIX. Without this,
// `setConfigValue` below writes into the developer's real `~/.agentbox/projects/`
// and the `afterEach` cleanup `rm -rf`s the real `~/.agentbox` (secrets.env, the
// box registry, prepared snapshots, SSH keys, logs). apps/cli has no vitest
// setup file (unlike packages/config), so we redirect HOME here. Every
// @agentbox/config / config-command import in this file is therefore DYNAMIC
// and lives BELOW this assignment — a static import would evaluate the module
// (capturing the real HOME) before this line runs.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agentbox-cfg-get-home-'));
process.env['HOME'] = TEST_HOME;

// Regression guard: `agentbox config get tools.gh.enabled` must
// return the deeply-nested boolean, not `<unset>`. The first iteration of the
// `leafValue`/`rawLeafFromValues` helpers in config.ts split on the FIRST dot
// only, so the 3-level key `tools.gh.enabled` resolved to
// `effective.tools["gh.enabled"]` (undefined), even though
// `config set` and `loadEffectiveConfig` correctly walked the full path.

let tmpCwd: string;
let prevCwd: string;

beforeEach(async () => {
  // realpath so the hash matches what setConfigValue → findProjectRoot computes.
  tmpCwd = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-cfg-get-')));
  prevCwd = process.cwd();
  process.chdir(tmpCwd);
  // Commander caches parsed options on the singleton `configCommand`; reset
  // module state so each parseAsync starts from a clean slate (otherwise
  // `--json`/`--all` from a prior test leak into the next).
  vi.resetModules();
});

afterEach(async () => {
  process.chdir(prevCwd);
  await rm(tmpCwd, { recursive: true, force: true });
  // Clear the isolated HOME's `.agentbox` between tests so project configs
  // written under TEST_HOME/projects/ don't leak across cases. HOME is
  // redirected to a throwaway dir at module load (see top of file), so this
  // never touches the developer's real `~/.agentbox`.
  await resetTempAgentboxHome();
});

afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

// Dynamic import so @agentbox/config evaluates AFTER the HOME redirect above
// (see the module-top comment). resetModules() in beforeEach makes this a fresh
// instance per test; it still resolves STATE_DIR under TEST_HOME.
async function setProjectGhDisabled(): Promise<void> {
  const { setConfigValue } = await import('@agentbox/config');
  await setConfigValue('project', 'tools.gh.enabled', 'false', tmpCwd, {
    raw: true,
  });
}

async function runConfigGet(args: string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  try {
    // Dynamic import after vi.resetModules() so the `getCommand`'s
    // commander state is fresh per test.
    const { configCommand } = await import('../src/commands/config.js');
    await configCommand.parseAsync(['node', 'agentbox-config', ...args]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
  return { stdout, stderr };
}

describe('config get on a nested 3-level key', () => {
  it('returns the leaf value, not <unset>', async () => {
    await setProjectGhDisabled();
    const { stdout } = await runConfigGet(['get', 'tools.gh.enabled']);
    expect(stdout).toContain('tools.gh.enabled = false');
    expect(stdout).toMatch(/from: project /);
    expect(stdout).not.toContain('<unset>');
  });

  it('--json carries the value and source', async () => {
    await setProjectGhDisabled();
    const { stdout } = await runConfigGet(['get', 'tools.gh.enabled', '--json']);
    const parsed = JSON.parse(stdout) as { key: string; value: unknown; source: string };
    expect(parsed.key).toBe('tools.gh.enabled');
    expect(parsed.value).toBe(false);
    expect(parsed.source).toBe('project');
  });

  it('--all walks every layer (no silent <unset> for the project layer)', async () => {
    await setProjectGhDisabled();
    const { stdout } = await runConfigGet(['get', 'tools.gh.enabled', '--all']);
    expect(stdout).toMatch(/effective: false /);
    expect(stdout).toMatch(/project:\s+false /);
    expect(stdout).toMatch(/default:\s+true/);
  });

  it('unset key falls back to the built-in default (true)', async () => {
    const { stdout } = await runConfigGet(['get', 'tools.gh.enabled']);
    expect(stdout).toContain('tools.gh.enabled = true');
    expect(stdout).toMatch(/from: built-in default/);
  });
});
