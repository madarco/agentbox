import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the sbx CLI driver so the refresh path is deterministic and offline.
const detectSbx = vi.fn();
const refreshSbxToken = vi.fn();
vi.mock('../src/sbx-cli.js', () => ({
  detectSbx: (...a: unknown[]) => detectSbx(...a),
  refreshSbxToken: (...a: unknown[]) => refreshSbxToken(...a),
}));

const { resolveCredentials, hasUsableCredentials, ensureFreshCredentials } = await import(
  '../src/sdk.js'
);
const { reloadVercelEnv } = await import('../src/env-loader.js');

const ENV_KEYS = [
  'VERCEL_OIDC_TOKEN',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
  'VERCEL_AUTH_SOURCE',
  'AGENTBOX_VERCEL_CLI_DIR',
  'HOME',
] as const;

let saved: Record<string, string | undefined>;
let dir: string;

function writeAuth(token: string, expiresAt: number): void {
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ token, expiresAt, refreshToken: 'vcr_x' }));
}

const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;
const PAST = () => Math.floor(Date.now() / 1000) - 3600;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = '/nonexistent-agentbox-test-home';
  dir = mkdtempSync(join(tmpdir(), 'agentbox-cliauth-'));
  process.env.AGENTBOX_VERCEL_CLI_DIR = dir;
  detectSbx.mockReset();
  refreshSbxToken.mockReset();
  reloadVercelEnv();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  reloadVercelEnv();
});

describe('resolveCredentials — CLI mode', () => {
  it('returns the live token from the CLI store + cached ids', () => {
    writeAuth('vca_live', FUTURE());
    process.env.VERCEL_AUTH_SOURCE = 'cli';
    process.env.VERCEL_TEAM_ID = 'team_1';
    process.env.VERCEL_PROJECT_ID = 'prj_1';
    expect(hasUsableCredentials()).toBe(true);
    expect(resolveCredentials()).toEqual({ token: 'vca_live', teamId: 'team_1', projectId: 'prj_1' });
  });

  it('throws when the CLI session is logged out (no auth.json)', () => {
    process.env.VERCEL_AUTH_SOURCE = 'cli';
    process.env.VERCEL_TEAM_ID = 'team_1';
    process.env.VERCEL_PROJECT_ID = 'prj_1';
    expect(hasUsableCredentials()).toBe(false);
    expect(() => resolveCredentials()).toThrow(/CLI session not found/i);
  });

  it('throws when team/project ids are missing', () => {
    writeAuth('vca_live', FUTURE());
    process.env.VERCEL_AUTH_SOURCE = 'cli';
    // no team/project, and config.json has no currentTeam
    expect(() => resolveCredentials()).toThrow(/missing the team\/project id/i);
  });

  it('falls back to the CLI currentTeam when VERCEL_TEAM_ID is unset', () => {
    writeAuth('vca_live', FUTURE());
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ currentTeam: 'team_cfg' }));
    process.env.VERCEL_AUTH_SOURCE = 'cli';
    process.env.VERCEL_PROJECT_ID = 'prj_1';
    expect(resolveCredentials()).toEqual({
      token: 'vca_live',
      teamId: 'team_cfg',
      projectId: 'prj_1',
    });
  });
});

describe('ensureFreshCredentials', () => {
  it('is a no-op for non-CLI auth modes', async () => {
    process.env.VERCEL_TOKEN = 't';
    await ensureFreshCredentials();
    expect(detectSbx).not.toHaveBeenCalled();
  });

  it('does nothing when the token is still valid', async () => {
    writeAuth('vca_valid', FUTURE());
    process.env.VERCEL_AUTH_SOURCE = 'cli';
    await ensureFreshCredentials();
    expect(detectSbx).not.toHaveBeenCalled();
    expect(refreshSbxToken).not.toHaveBeenCalled();
  });

  it('refreshes via the CLI when near expiry, then sees the rotated token', async () => {
    writeAuth('vca_old', PAST());
    process.env.VERCEL_AUTH_SOURCE = 'cli';
    detectSbx.mockResolvedValue({ installed: true, bin: 'sbx' });
    refreshSbxToken.mockImplementation(async () => {
      writeAuth('vca_new', FUTURE()); // simulate the CLI rotating its store
      return true;
    });
    await expect(ensureFreshCredentials()).resolves.toBeUndefined();
    expect(refreshSbxToken).toHaveBeenCalledOnce();
    process.env.VERCEL_TEAM_ID = 'team_1';
    process.env.VERCEL_PROJECT_ID = 'prj_1';
    expect(resolveCredentials().token).toBe('vca_new');
  });

  it('throws an actionable error when the CLI is gone', async () => {
    writeAuth('vca_old', PAST());
    process.env.VERCEL_AUTH_SOURCE = 'cli';
    detectSbx.mockResolvedValue({ installed: false });
    await expect(ensureFreshCredentials()).rejects.toThrow(/no longer installed|vercel login/i);
  });

  it('throws when the refresh command fails', async () => {
    writeAuth('vca_old', PAST());
    process.env.VERCEL_AUTH_SOURCE = 'cli';
    detectSbx.mockResolvedValue({ installed: true, bin: 'sbx' });
    refreshSbxToken.mockResolvedValue(false);
    await expect(ensureFreshCredentials()).rejects.toThrow(/refresh failed/i);
  });

  it('throws when the token is still stale after a refresh', async () => {
    writeAuth('vca_old', PAST());
    process.env.VERCEL_AUTH_SOURCE = 'cli';
    detectSbx.mockResolvedValue({ installed: true, bin: 'sbx' });
    refreshSbxToken.mockResolvedValue(true); // claims success but store stays stale
    await expect(ensureFreshCredentials()).rejects.toThrow(/still stale/i);
  });

  it('collapses to a single refresh and re-reads the rotated token', async () => {
    writeAuth('vca_old', PAST());
    process.env.VERCEL_AUTH_SOURCE = 'cli';
    detectSbx.mockResolvedValue({ installed: true, bin: 'sandbox' });
    refreshSbxToken.mockImplementation(async () => {
      writeAuth('vca_rotated', FUTURE());
      return true;
    });
    await ensureFreshCredentials();
    expect(detectSbx).toHaveBeenCalledOnce();
  });
});
