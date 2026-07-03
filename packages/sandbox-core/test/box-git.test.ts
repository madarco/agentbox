import type { BoxRecord, ExecResult, GitRpcParams, Provider } from '@agentbox/core';
import { describe, expect, it } from 'vitest';
import {
  boxGitCheckout,
  boxGitNewBranch,
  boxGitPull,
  boxGitPush,
  boxGitPushHost,
  boxRestartServices,
  scratchBranchName,
  servicesStatusArgv,
} from '../src/box-git.js';

// A fake provider that records every exec argv and returns a canned result.
function recorder(exit = 0): { provider: Provider; calls: string[][] } {
  const calls: string[][] = [];
  const provider = {
    exec(_box: BoxRecord, argv: string[]): Promise<ExecResult> {
      calls.push(argv);
      return Promise.resolve({ exitCode: exit, stdout: '', stderr: '' });
    },
  } as unknown as Provider;
  return { provider, calls };
}

const box = { id: 'b1' } as unknown as BoxRecord;

describe('scratchBranchName', () => {
  it('prefixes agentbox/ when missing and is idempotent', () => {
    expect(scratchBranchName('feature')).toBe('agentbox/feature');
    expect(scratchBranchName('agentbox/feature')).toBe('agentbox/feature');
    expect(scratchBranchName('  spaced  ')).toBe('agentbox/spaced');
  });
});

describe('boxGitCheckout / boxGitNewBranch', () => {
  it('checkout runs raw git in the workspace (no relay)', async () => {
    const { provider, calls } = recorder();
    await boxGitCheckout(provider, box, 'main');
    expect(calls[0]).toEqual(['git', 'checkout', 'main']);
  });

  it('new branch creates+switches and normalizes the name', async () => {
    const { provider, calls } = recorder();
    await boxGitNewBranch(provider, box, 'wip', 'main');
    expect(calls[0]).toEqual(['git', 'checkout', '-b', 'agentbox/wip', 'main']);
  });

  it('new branch defaults the base to HEAD (omits the ref)', async () => {
    const { provider, calls } = recorder();
    await boxGitNewBranch(provider, box, 'agentbox/wip');
    expect(calls[0]).toEqual(['git', 'checkout', '-b', 'agentbox/wip']);
  });
});

describe('boxGitPush', () => {
  it('appends --force last and passes the same params to the token minter', async () => {
    const { provider, calls } = recorder();
    const seen: { method: string; params: GitRpcParams }[] = [];
    await boxGitPush(
      provider,
      box,
      { remote: 'origin', force: true },
      {
        hostInitiatedArgs: (method, params) => {
          seen.push({ method, params });
          return Promise.resolve(['--host-initiated-token', 'TOK']);
        },
      },
    );
    // Token args splice in right after the subcommand; --remote then the args tail.
    expect(calls[0]).toEqual([
      'agentbox-ctl',
      'git',
      'push',
      '--host-initiated-token',
      'TOK',
      '--remote',
      'origin',
      '--force',
    ]);
    // The minted token is bound to exactly the params ctl will send.
    expect(seen[0]).toEqual({ method: 'git.push', params: { path: '/workspace', remote: 'origin', args: ['--force'] } });
  });

  it('works with no deps (no token) for scratch pushes', async () => {
    const { provider, calls } = recorder();
    await boxGitPush(provider, box, {});
    expect(calls[0]).toEqual(['agentbox-ctl', 'git', 'push']);
  });
});

describe('boxGitPull', () => {
  it('scopes the token to git.fetch and keeps --ff-only out of the hash', async () => {
    const { provider, calls } = recorder();
    const seen: { method: string; params: GitRpcParams }[] = [];
    await boxGitPull(
      provider,
      box,
      { remote: 'upstream', ffOnly: true },
      {
        hostInitiatedArgs: (method, params) => {
          seen.push({ method, params });
          return Promise.resolve([]);
        },
      },
    );
    expect(calls[0]).toEqual(['agentbox-ctl', 'git', 'pull', '--remote', 'upstream', '--ff-only']);
    expect(seen[0]).toEqual({ method: 'git.fetch', params: { path: '/workspace', remote: 'upstream' } });
  });
});

describe('boxGitPushHost', () => {
  it('uses --host-only and never mints a token', async () => {
    const { provider, calls } = recorder();
    await boxGitPushHost(provider, box, { as: 'saved', force: true });
    expect(calls[0]).toEqual(['agentbox-ctl', 'git', 'push', '--host-only', '--as', 'saved', '--force']);
  });
});

describe('services control', () => {
  it('servicesStatusArgv is the ctl status --json pull', () => {
    expect(servicesStatusArgv()).toEqual(['agentbox-ctl', 'status', '--json']);
  });

  it('boxRestartServices restarts each name in sequence', async () => {
    const { provider, calls } = recorder();
    const out = await boxRestartServices(provider, box, ['web', 'db']);
    expect(calls).toEqual([
      ['agentbox-ctl', 'restart', 'web'],
      ['agentbox-ctl', 'restart', 'db'],
    ]);
    expect(out.map((r) => r.name)).toEqual(['web', 'db']);
  });
});
