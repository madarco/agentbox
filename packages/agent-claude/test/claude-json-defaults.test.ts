import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultBoxClaudeJson } from '../src/claude-json-defaults.js';
import { stageClaudeJsonOnlyForUpload } from '../src/host-stage.js';

describe('defaultBoxClaudeJson', () => {
  it('is pre-onboarded, native-install and trusts the workspace', () => {
    expect(defaultBoxClaudeJson('/workspace')).toEqual({
      installMethod: 'native',
      autoUpdates: false,
      autoUpdatesProtectedForNative: true,
      hasCompletedOnboarding: true,
      projects: { '/workspace': { hasTrustDialogAccepted: true } },
    });
  });

  it('returns a fresh object each call', () => {
    const a = defaultBoxClaudeJson('/workspace');
    a['hasCompletedOnboarding'] = false;
    expect(defaultBoxClaudeJson('/workspace')['hasCompletedOnboarding']).toBe(true);
  });
});

describe('cloud overlay with no host ~/.claude.json', () => {
  let hostHome: string;
  beforeEach(async () => {
    hostHome = await mkdtemp(join(tmpdir(), 'claude-json-defaults-'));
  });
  afterEach(async () => {
    await rm(hostHome, { recursive: true, force: true });
  });

  it('stages exactly the shared default', async () => {
    const staged = await stageClaudeJsonOnlyForUpload({ hostHome });
    const tarball = staged.tarballPath;
    if (!tarball) throw new Error('nothing staged');
    try {
      const raw = execFileSync('tar', ['-xOzf', tarball, './_claude.json']).toString('utf8');
      expect(JSON.parse(raw)).toEqual(defaultBoxClaudeJson('/workspace'));
    } finally {
      await staged.cleanup();
    }
  });
});
