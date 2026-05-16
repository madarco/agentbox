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
    expect(updateCommand.name()).toBe('update');
    const longs = updateCommand.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--yes', '--dry-run', '--skip-self']));
  });
});
