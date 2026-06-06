import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfigValue } from '@agentbox/config';

// Regression guard: `agentbox config get integrations.notion.enabled` must
// return the deeply-nested boolean, not `<unset>`. The first iteration of the
// `leafValue`/`rawLeafFromValues` helpers in config.ts split on the FIRST dot
// only, so the 3-level key `integrations.notion.enabled` resolved to
// `effective.integrations["notion.enabled"]` (undefined), even though
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
  // setConfigValue writes under ~/.agentbox/projects/<hash>/; clear it like
  // set-unset-roundtrip.test.ts does (STATE_DIR is captured at module load
  // from homedir(), so we can't redirect it per-test).
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});

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
    await setConfigValue('project', 'integrations.notion.enabled', 'true', tmpCwd, {
      raw: true,
    });
    const { stdout } = await runConfigGet(['get', 'integrations.notion.enabled']);
    expect(stdout).toContain('integrations.notion.enabled = true');
    expect(stdout).toMatch(/from: project /);
    expect(stdout).not.toContain('<unset>');
  });

  it('--json carries the value and source', async () => {
    await setConfigValue('project', 'integrations.notion.enabled', 'true', tmpCwd, {
      raw: true,
    });
    const { stdout } = await runConfigGet([
      'get',
      'integrations.notion.enabled',
      '--json',
    ]);
    const parsed = JSON.parse(stdout) as { key: string; value: unknown; source: string };
    expect(parsed.key).toBe('integrations.notion.enabled');
    expect(parsed.value).toBe(true);
    expect(parsed.source).toBe('project');
  });

  it('--all walks every layer (no silent <unset> for the project layer)', async () => {
    await setConfigValue('project', 'integrations.notion.enabled', 'true', tmpCwd, {
      raw: true,
    });
    const { stdout } = await runConfigGet([
      'get',
      'integrations.notion.enabled',
      '--all',
    ]);
    expect(stdout).toMatch(/effective: true /);
    expect(stdout).toMatch(/project:\s+true /);
    expect(stdout).toMatch(/default:\s+false/);
  });

  it('unset key falls back to the built-in default (false)', async () => {
    const { stdout } = await runConfigGet(['get', 'integrations.notion.enabled']);
    expect(stdout).toContain('integrations.notion.enabled = false');
    expect(stdout).toMatch(/from: built-in default/);
  });
});
