import { describe, expect, it } from 'vitest';
import { buildParams, partitionPullArgs } from '../src/commands/git.js';

const CWD = '/workspace';

describe('git push buildParams', () => {
  it('forwards a normal remote push with just path', () => {
    expect(buildParams({ cwd: CWD }, [])).toEqual({ path: CWD });
  });

  it('keeps extra git args for a remote push', () => {
    expect(buildParams({ cwd: CWD }, ['--tags'])).toEqual({
      path: CWD,
      args: ['--tags'],
    });
  });

  // Regression: --force is a known option (for --host-only), so Commander
  // consumes it into opts.force. On a *remote* push it must still reach git,
  // so it's re-appended to the forwarded args (the relay ignores params.force
  // outside the host-only land path).
  it('re-forwards --force as a git arg on a remote push', () => {
    expect(buildParams({ cwd: CWD, force: true }, [])).toEqual({
      path: CWD,
      args: ['--force'],
    });
    expect(buildParams({ cwd: CWD, force: true }, ['--tags'])).toEqual({
      path: CWD,
      args: ['--tags', '--force'],
    });
  });

  it('does not set params.force on a remote push', () => {
    expect(buildParams({ cwd: CWD, force: true }, []).force).toBeUndefined();
  });

  it('host-only carries hostOnly/as/force as params, not as git args', () => {
    expect(buildParams({ cwd: CWD, hostOnly: true, as: 'feat/x', force: true }, [])).toEqual({
      path: CWD,
      hostOnly: true,
      as: 'feat/x',
      force: true,
    });
  });

  it('host-only defaults the destination (no as) and stays off git args', () => {
    expect(buildParams({ cwd: CWD, hostOnly: true }, [])).toEqual({
      path: CWD,
      hostOnly: true,
    });
  });
});

describe('partitionPullArgs', () => {
  // Regression: the git shim forwards flags after a `--`, so commander leaves
  // opts.ffOnly unset and --ff-only landed on the host `git fetch`, which
  // rejects it ("unknown option `ff-only'"). It belongs on the local merge.
  it('routes --ff-only to the merge, never to the fetch', () => {
    expect(partitionPullArgs(['--ff-only'])).toEqual({
      fetchArgs: [],
      mergeArgs: ['--ff-only'],
    });
  });

  it('routes fetch-only flags to the fetch', () => {
    expect(partitionPullArgs(['--prune', '--no-tags'])).toEqual({
      fetchArgs: ['--prune', '--no-tags'],
      mergeArgs: [],
    });
  });

  it('sends --quiet to both, since either step can be noisy', () => {
    expect(partitionPullArgs(['-q'])).toEqual({ fetchArgs: ['-q'], mergeArgs: ['-q'] });
    expect(partitionPullArgs(['--quiet', '--prune', '--ff-only'])).toEqual({
      fetchArgs: ['--quiet', '--prune'],
      mergeArgs: ['--quiet', '--ff-only'],
    });
  });

  it('is a no-op on empty args', () => {
    expect(partitionPullArgs([])).toEqual({ fetchArgs: [], mergeArgs: [] });
  });
});
