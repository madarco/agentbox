import { describe, expect, it } from 'vitest';
import type {
  ResyncExecResult,
  ResyncWorktree,
  WorkspaceResyncPorts,
} from '@agentbox/core';
import { resyncWorkspace } from '../src/sync/concerns/git.js';

interface Call {
  method: string;
  args: unknown[];
}

// Scripted fake ports: records every call and returns canned results, so
// resyncWorkspace's whole observable effect is the ordered port calls + the
// per-repo result it returns. (The RecordingSyncTransport pattern, applied to
// the resync ports.)
function makeFakePorts(
  o: {
    hostRef?: string | null;
    hostStash?: string | null;
    hostUntracked?: string[];
    boxTokens?: Map<string, string>;
    hashHostFile?: (rel: string) => string; // may throw
    packResult?: Buffer | null;
    boxGit?: (ct: string, args: string[]) => ResyncExecResult;
  } = {},
): { ports: WorkspaceResyncPorts; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const ports: WorkspaceResyncPorts = {
    async resolveHostRef(hostMain) {
      rec('resolveHostRef', hostMain);
      return o.hostRef === undefined ? 'main' : o.hostRef;
    },
    async createHostStash(hostMain) {
      rec('createHostStash', hostMain);
      return o.hostStash === undefined ? null : o.hostStash;
    },
    async listHostUntracked(hostMain) {
      rec('listHostUntracked', hostMain);
      return o.hostUntracked ?? [];
    },
    async hashHostFile(hostMain, rel) {
      rec('hashHostFile', hostMain, rel);
      if (!o.hashHostFile) throw new Error('unreadable');
      return o.hashHostFile(rel);
    },
    async packHostFiles(hostMain, rels) {
      rec('packHostFiles', hostMain, rels);
      return o.packResult === undefined ? Buffer.from('tar') : o.packResult;
    },
    async boxGit(ct, args) {
      rec('boxGit', ct, args);
      return o.boxGit ? o.boxGit(ct, args) : { exitCode: 0, stdout: '', stderr: '' };
    },
    async probeUntrackedTokens(ct, rels) {
      rec('probeUntrackedTokens', ct, rels);
      return o.boxTokens ?? new Map<string, string>();
    },
    async applyTarToBox(ct, tar) {
      rec('applyTarToBox', ct, tar);
    },
  };
  return { ports, calls };
}

const boxGitArgs = (calls: Call[]): string[][] =>
  calls.filter((c) => c.method === 'boxGit').map((c) => c.args[1] as string[]);

describe('git concern — resyncWorkspace', () => {
  it('overlays host untracked files box-wins: copy absent, no-op identical, skip differing', async () => {
    const wt: ResyncWorktree = {
      containerPath: '/workspace',
      hostMainRepo: '/host/repo',
      branch: 'main',
    };
    const { ports, calls } = makeFakePorts({
      hostRef: 'main', // === branch → merge block skipped
      hostStash: null, // no uncommitted overlay
      hostUntracked: ['new.txt', 'same.txt', 'diff.txt'],
      // new.txt absent in box; same.txt byte-identical; diff.txt differs.
      boxTokens: new Map([
        ['same.txt', 'HASH_SAME'],
        ['diff.txt', 'HASH_BOX'],
      ]),
      hashHostFile: (rel) => (rel === 'same.txt' ? 'HASH_SAME' : 'HASH_HOST_DIFF'),
      packResult: Buffer.from('tarball'),
    });

    const results = await resyncWorkspace([wt], ports);

    expect(results).toEqual([
      { containerPath: '/workspace', mergeConflicts: [], overlaySkipped: ['diff.txt'] },
    ]);
    // Only the absent file is packed + applied; the box keeps same.txt & diff.txt.
    const pack = calls.find((c) => c.method === 'packHostFiles');
    expect(pack?.args[1]).toEqual(['new.txt']);
    expect(calls.some((c) => c.method === 'applyTarToBox')).toBe(true);
    // hostRef === branch → the merge block never touches the box worktree.
    expect(boxGitArgs(calls)).toEqual([]);
  });

  it('merges host commits into the box branch and commits the merge (no conflicts)', async () => {
    const wt: ResyncWorktree = {
      containerPath: '/workspace',
      hostMainRepo: '/host/repo',
      branch: 'box-branch',
    };
    const boxGit = (_ct: string, args: string[]): ResyncExecResult => {
      if (args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' }; // clean
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: '2', stderr: '' };
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'MERGE', stderr: '' }; // MERGE_HEAD present
      if (args[0] === 'diff') return { exitCode: 0, stdout: '', stderr: '' }; // no unmerged
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const { ports, calls } = makeFakePorts({ hostRef: 'main', boxGit });
    const logs: string[] = [];

    const results = await resyncWorkspace([wt], ports, (l) => logs.push(l));

    expect(results[0]).toEqual({
      containerPath: '/workspace',
      mergeConflicts: [],
      overlaySkipped: [],
    });
    const args = boxGitArgs(calls);
    expect(args.some((a) => a[0] === 'merge' && a[1] === '--no-commit' && a[2] === 'main')).toBe(true);
    // mergeInProgress → the merge is committed as the agentbox identity.
    expect(args.some((a) => a.includes('commit') && a.includes('--no-edit'))).toBe(true);
    expect(logs.some((l) => l.includes('merged 2 new host commit(s) from main'))).toBe(true);
  });

  it('keeps the box version on a merge conflict (checkout --ours) and reports it', async () => {
    const wt: ResyncWorktree = {
      containerPath: '/workspace',
      hostMainRepo: '/host/repo',
      branch: 'box-branch',
    };
    const boxGit = (_ct: string, args: string[]): ResyncExecResult => {
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'MERGE', stderr: '' };
      if (args[0] === 'diff') return { exitCode: 0, stdout: 'a.ts\0b.ts\0', stderr: '' }; // unmerged
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const { ports, calls } = makeFakePorts({ hostRef: 'main', boxGit });

    const results = await resyncWorkspace([wt], ports);

    expect(results[0]?.mergeConflicts).toEqual(['a.ts', 'b.ts']);
    const args = boxGitArgs(calls);
    expect(args.some((a) => a[0] === 'checkout' && a[1] === '--ours')).toBe(true);
    expect(args.some((a) => a[0] === 'add')).toBe(true);
  });

  it('skips a worktree whose host ref cannot be resolved (no box mutation)', async () => {
    const { ports, calls } = makeFakePorts({ hostRef: null });
    const logs: string[] = [];

    const results = await resyncWorkspace(
      [{ containerPath: '/w', hostMainRepo: '/r', branch: 'b' }],
      ports,
      (l) => logs.push(l),
    );

    expect(results).toEqual([{ containerPath: '/w', mergeConflicts: [], overlaySkipped: [] }]);
    expect(calls.filter((c) => c.method === 'boxGit')).toEqual([]);
    expect(logs.some((l) => l.includes('could not resolve host ref'))).toBe(true);
  });
});
