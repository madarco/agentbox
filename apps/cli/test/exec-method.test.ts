import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectExecutionMethod } from '../src/exec-method.js';
import { updateCommand } from '../src/commands/update.js';

describe('detectExecutionMethod', () => {
  it('detects npx from the _npx cache path in argv1', () => {
    expect(
      detectExecutionMethod({
        argv1: '/Users/x/.npm/_npx/abc123/node_modules/.bin/agentbox',
        userAgent: 'npm/10.2.0 node/v22.0.0 darwin arm64',
      }),
    ).toBe('npx');
  });

  it('detects npx from the user-agent token (npm path missing)', () => {
    expect(
      detectExecutionMethod({
        argv1: '/usr/local/bin/agentbox',
        userAgent: 'npm/10.9.0 node/v22.0.0 darwin arm64 npx/10.9.0',
      }),
    ).toBe('npx');
  });

  it('detects pnpm', () => {
    expect(
      detectExecutionMethod({
        argv1: '/Users/x/Library/pnpm/agentbox',
        userAgent: 'pnpm/9.15.0 npm/? node/v22.0.0 darwin arm64',
      }),
    ).toBe('pnpm');
  });

  it('detects npm global install', () => {
    expect(
      detectExecutionMethod({
        argv1: '/opt/homebrew/lib/node_modules/agentbox/dist/index.js',
        userAgent: 'npm/10.2.0 node/v22.0.0 darwin arm64',
      }),
    ).toBe('npm');
  });

  // The common real-world case: a global bin invoked straight from the shell
  // carries NO npm user-agent, and argv1 is the bin symlink. Detection must
  // resolve the symlink instead of misreading it as a dev checkout — that
  // misdetection made `self-update` skip the package update entirely.
  it('detects an npm global install invoked from the shell (bin symlink, no user-agent)', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbox-exec-npm-'));
    try {
      const script = join(root, 'lib', 'node_modules', '@madarco', 'agentbox', 'dist', 'index.js');
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(script, '..'), { recursive: true });
      writeFileSync(script, '');
      symlinkSync(script, join(root, 'bin', 'agentbox'));
      expect(
        detectExecutionMethod({ argv1: join(root, 'bin', 'agentbox'), userAgent: undefined }),
      ).toBe('npm');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects a pnpm global install invoked from the shell (PNPM_HOME/global, no user-agent)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agentbox-exec-pnpm-'));
    try {
      // pnpm's global dir is project-shaped: <PNPM_HOME>/global/5 holds a
      // node_modules/.pnpm store just like a project would.
      const home = join(tmp, 'Library', 'pnpm');
      const script = join(
        home,
        'global',
        '5',
        'node_modules',
        '.pnpm',
        '@madarco+agentbox@0.22.1',
        'node_modules',
        '@madarco',
        'agentbox',
        'dist',
        'index.js',
      );
      mkdirSync(home, { recursive: true });
      mkdirSync(join(script, '..'), { recursive: true });
      writeFileSync(script, '');
      symlinkSync(script, join(home, 'agentbox'));
      expect(
        detectExecutionMethod({ argv1: join(home, 'agentbox'), userAgent: undefined }),
      ).toBe('pnpm');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('treats a project-local install as direct (no global add over a local dep)', () => {
    // A node_modules/.bin shim resolves into the project's own store — local
    // pnpm layout first, plain local node_modules second.
    expect(
      detectExecutionMethod({
        argv1:
          '/Users/x/proj/node_modules/.pnpm/@madarco+agentbox@0.22.1/node_modules/@madarco/agentbox/dist/index.js',
        userAgent: undefined,
      }),
    ).toBe('direct');
    expect(
      detectExecutionMethod({
        argv1: '/Users/x/proj/node_modules/@madarco/agentbox/dist/index.js',
        userAgent: undefined,
      }),
    ).toBe('direct');
  });

  it('classifies on the literal path when it does not exist (no user-agent)', () => {
    expect(
      detectExecutionMethod({
        argv1: '/opt/homebrew/lib/node_modules/@madarco/agentbox/dist/index.js',
        userAgent: undefined,
      }),
    ).toBe('npm');
  });

  it('falls back to direct for a dev clone / bare node invocation', () => {
    expect(
      detectExecutionMethod({
        argv1: '/Users/x/Projects/agentbox/apps/cli/dist/index.js',
        userAgent: undefined,
      }),
    ).toBe('direct');
  });

  it('treats an empty input as direct', () => {
    expect(detectExecutionMethod({})).toBe('direct');
  });
});

describe('update command surface', () => {
  it('is registered with -y/--yes, --dry-run and --skip-self', () => {
    expect(updateCommand.name()).toBe('self-update');
    const longs = updateCommand.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--yes', '--dry-run', '--skip-self']));
  });
});
