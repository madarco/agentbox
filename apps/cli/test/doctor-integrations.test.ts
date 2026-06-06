/**
 * Unit tests for the `integrations:` group in `agentbox doctor`.
 *
 * The real `ntn` lives only on the host (this box can't install it), so the
 * test stages a tiny shell script named `ntn` on a private PATH and asserts
 * the four meaningful transitions: disabled → info, enabled+missing → warn,
 * enabled+present-but-unauthed → warn (with the login hint), enabled+ok → ok.
 *
 * Config is injected via the `IntegrationsConfigLoader` parameter rather than
 * touched on disk — same pattern `refuseIfIntegrationDisabled` uses in the
 * relay, so the test stays pure (no `~/.agentbox` touch).
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  integrationsChecks,
  type IntegrationsConfigLoader,
} from '../src/lib/doctor-checks.js';

const NTN_SCRIPT = `#!/usr/bin/env bash
case "$1" in
  --version)
    echo "ntn version 0.42.0"
    exit 0 ;;
  api)
    if [ "$NTN_TEST_AUTH" = "ok" ]; then
      echo '{"object":"user","id":"stub"}'
      exit 0
    fi
    echo "Error: not logged in. Run 'ntn login' to authenticate." >&2
    exit 1 ;;
  *)
    echo "stub: unknown subcommand $1" >&2
    exit 2 ;;
esac
`;

const enabled: IntegrationsConfigLoader = () =>
  Promise.resolve({ effective: { integrations: { notion: { enabled: true } } } });
const disabled: IntegrationsConfigLoader = () => Promise.resolve({ effective: {} });

describe('doctor — integrations group', () => {
  let stubDir: string;
  let originalPath: string | undefined;
  let originalAuth: string | undefined;

  beforeEach(async () => {
    stubDir = await mkdtemp(join(tmpdir(), 'agentbox-doctor-int-'));
    originalPath = process.env.PATH;
    originalAuth = process.env.NTN_TEST_AUTH;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalAuth === undefined) delete process.env.NTN_TEST_AUTH;
    else process.env.NTN_TEST_AUTH = originalAuth;
    await rm(stubDir, { recursive: true, force: true });
  });

  async function stageStub(): Promise<void> {
    const ntn = join(stubDir, 'ntn');
    await writeFile(ntn, NTN_SCRIPT, 'utf8');
    await chmod(ntn, 0o755);
    // Prepend the stub dir so our fake `ntn` wins over any real one, but
    // keep the original PATH so the script's `#!/usr/bin/env bash` shebang
    // can still resolve `bash` (env in /usr/bin uses the child's PATH).
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`;
  }

  function emptyPath(): void {
    // Only the empty stub dir — execa(`ntn`) gets ENOENT directly (no
    // shebang interpretation needed for a missing binary).
    process.env.PATH = stubDir;
  }

  it('renders info / "disabled" when the flag is off (default)', async () => {
    emptyPath();
    const results = await integrationsChecks(disabled);
    // One row per registered connector (notion, linear, …). All should
    // surface as `info`/disabled when no flag has been flipped — disabling
    // an integration is a setting, not a problem.
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const row of results) {
      expect(row.status).toBe('info');
      expect(row.detail).toBe('disabled');
      expect(row.hint).toContain(`integrations.${row.label}.enabled true`);
    }
    const notion = results.find((r) => r.label === 'notion');
    expect(notion).toBeDefined();
    const linear = results.find((r) => r.label === 'linear');
    expect(linear).toBeDefined();
  });

  it('renders warn / "not installed" when enabled but ntn is missing', async () => {
    emptyPath();
    const results = await integrationsChecks(enabled);
    const row = results.find((r) => r.label === 'notion')!;
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/not installed/);
    expect(row.hint).toMatch(/install ntn/);
  });

  it('renders warn / "not logged in" when ntn is present but unauthed', async () => {
    await stageStub();
    delete process.env.NTN_TEST_AUTH;
    const results = await integrationsChecks(enabled);
    const row = results.find((r) => r.label === 'notion')!;
    expect(row.status).toBe('warn');
    expect(row.detail).toBe('not logged in');
    expect(row.hint).toBe('ntn login');
  });

  it('renders ok with the version line when ntn is present and authed', async () => {
    await stageStub();
    process.env.NTN_TEST_AUTH = 'ok';
    const results = await integrationsChecks(enabled);
    const row = results.find((r) => r.label === 'notion')!;
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('ntn version 0.42.0');
    expect(row.detail).toContain('authed');
  });

  it('fails closed (no throw) when the config loader rejects', async () => {
    emptyPath();
    const broken: IntegrationsConfigLoader = () =>
      Promise.reject(new Error('malformed yaml'));
    const results = await integrationsChecks(broken);
    // Every row falls back to disabled (info), regardless of which connectors
    // are registered — a broken config is treated as "not enabled".
    for (const row of results) expect(row.status).toBe('info');
  });
});
