import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cliStorePaths,
  isNearExpiry,
  readCliAuth,
  readCliCurrentTeam,
  vercelCliDir,
} from '../src/cli-store.js';

const REAL_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    AGENTBOX_VERCEL_CLI_DIR: process.env.AGENTBOX_VERCEL_CLI_DIR,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    APPDATA: process.env.APPDATA,
    HOME: process.env.HOME,
  };
  delete process.env.AGENTBOX_VERCEL_CLI_DIR;
  delete process.env.XDG_DATA_HOME;
});

afterEach(() => {
  setPlatform(REAL_PLATFORM);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('vercelCliDir', () => {
  it('uses ~/Library/Application Support on macOS', () => {
    setPlatform('darwin');
    process.env.HOME = '/Users/test';
    expect(vercelCliDir()).toBe('/Users/test/Library/Application Support/com.vercel.cli');
  });

  it('honours XDG_DATA_HOME on Linux', () => {
    setPlatform('linux');
    process.env.XDG_DATA_HOME = '/custom/data';
    expect(vercelCliDir()).toBe('/custom/data/com.vercel.cli');
  });

  it('falls back to ~/.local/share on Linux', () => {
    setPlatform('linux');
    process.env.HOME = '/home/test';
    expect(vercelCliDir()).toBe('/home/test/.local/share/com.vercel.cli');
  });

  it('uses %APPDATA% on Windows', () => {
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    expect(vercelCliDir()).toContain('com.vercel.cli');
    expect(vercelCliDir()).toContain('Roaming');
  });

  it('AGENTBOX_VERCEL_CLI_DIR overrides every platform', () => {
    setPlatform('darwin');
    process.env.AGENTBOX_VERCEL_CLI_DIR = '/override/dir';
    expect(vercelCliDir()).toBe('/override/dir');
    expect(cliStorePaths()).toEqual({
      authPath: '/override/dir/auth.json',
      configPath: '/override/dir/config.json',
    });
  });
});

describe('readCliAuth / readCliCurrentTeam', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentbox-clistore-'));
    process.env.AGENTBOX_VERCEL_CLI_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a well-formed auth.json', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ token: 'vca_x', expiresAt: 123, refreshToken: 'vcr_y' }),
    );
    expect(readCliAuth()).toEqual({ token: 'vca_x', expiresAt: 123, refreshToken: 'vcr_y' });
  });

  it('returns null when auth.json is missing', () => {
    expect(readCliAuth()).toBeNull();
  });

  it('returns null when auth.json is malformed', () => {
    writeFileSync(join(dir, 'auth.json'), '{ not json');
    expect(readCliAuth()).toBeNull();
  });

  it('returns null when there is no token', () => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ expiresAt: 123 }));
    expect(readCliAuth()).toBeNull();
  });

  it('reads currentTeam from config.json', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ currentTeam: 'team_z' }));
    expect(readCliCurrentTeam()).toBe('team_z');
  });

  it('returns null when config.json lacks currentTeam', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({}));
    expect(readCliCurrentTeam()).toBeNull();
  });
});

describe('isNearExpiry', () => {
  it('is false for a token well in the future', () => {
    expect(isNearExpiry({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 })).toBe(false);
  });

  it('is true for an expired token', () => {
    expect(isNearExpiry({ token: 't', expiresAt: Math.floor(Date.now() / 1000) - 10 })).toBe(true);
  });

  it('is true within the skew window', () => {
    expect(isNearExpiry({ token: 't', expiresAt: Math.floor(Date.now() / 1000) + 60 }, 120)).toBe(true);
  });

  it('treats a missing expiresAt as near-expiry', () => {
    expect(isNearExpiry({ token: 't' })).toBe(true);
  });
});
