import { describe, expect, it } from 'vitest';
import { branchTargetUnresolved, injectBoxBranch, parseWorktreeBranch } from '../src/gh.js';

describe('injectBoxBranch', () => {
  it('prepends --head <branch> for create/list when none was passed', () => {
    expect(injectBoxBranch('create', 'agentbox/box-one', ['--title', 'T'])).toEqual([
      '--head',
      'agentbox/box-one',
      '--title',
      'T',
    ]);
    expect(injectBoxBranch('list', 'agentbox/box-one', ['--json', 'number'])).toEqual([
      '--head',
      'agentbox/box-one',
      '--json',
      'number',
    ]);
  });

  it('prepends the branch as a positional ref for branch-targeting ops', () => {
    // Realistic flag-only argv per op (no positional ref) — each must get the
    // box branch prepended.
    const cases: Record<string, string[]> = {
      view: ['--json', 'number'],
      comment: ['--body', 'hi'],
      review: ['--approve'],
      merge: ['--squash'],
      close: ['--delete-branch'],
      reopen: [],
    };
    for (const [op, args] of Object.entries(cases)) {
      expect(injectBoxBranch(op as 'view', 'agentbox/box-one', args)).toEqual([
        'agentbox/box-one',
        ...args,
      ]);
    }
  });

  it('injects when the leading arg is a flag, never mistaking a flag value for a ref', () => {
    // A leading flag means "no ref" — its value must never be read as the ref,
    // for ANY op (no value-taking-flag table). Covers the bugbot cases: merge
    // --body, close --comment, reopen --comment, view --json, etc.
    const cases: [string, string[]][] = [
      ['view', ['--json', 'number,url']],
      ['comment', ['--body', 'text']],
      ['merge', ['--body', 'merge msg', '--squash']],
      ['merge', ['--subject', 's', '--match-head-commit', 'abc123']],
      ['close', ['--comment', 'closing']],
      ['reopen', ['--comment', 'reopening']],
    ];
    for (const [op, args] of cases) {
      expect(injectBoxBranch(op as 'merge', 'agentbox/box-one', args)).toEqual([
        'agentbox/box-one',
        ...args,
      ]);
    }
  });

  it('leaves an explicit leading positional ref alone', () => {
    expect(injectBoxBranch('view', 'agentbox/box-one', ['42', '--json', 'x'])).toEqual([
      '42',
      '--json',
      'x',
    ]);
    expect(injectBoxBranch('merge', 'agentbox/box-one', ['42'])).toEqual(['42']);
    // `--` end-of-options then the ref.
    expect(injectBoxBranch('view', 'agentbox/box-one', ['--', '42'])).toEqual(['--', '42']);
  });

  it('never injects for checkout', () => {
    expect(injectBoxBranch('checkout', 'agentbox/box-one', ['42'])).toEqual(['42']);
    expect(injectBoxBranch('checkout', 'agentbox/box-one', [])).toEqual([]);
  });

  it('does not double-inject when --head / -H is already present', () => {
    expect(injectBoxBranch('create', 'agentbox/box-one', ['--head', 'feat/x'])).toEqual([
      '--head',
      'feat/x',
    ]);
    expect(injectBoxBranch('create', 'agentbox/box-one', ['-Hfeat/x'])).toEqual(['-Hfeat/x']);
    expect(injectBoxBranch('list', 'agentbox/box-one', ['--head=feat/x'])).toEqual([
      '--head=feat/x',
    ]);
  });

  it('leaves args unchanged when no usable branch resolved', () => {
    expect(injectBoxBranch('view', undefined, ['--json', 'x'])).toEqual(['--json', 'x']);
    expect(injectBoxBranch('create', '', ['--title', 'T'])).toEqual(['--title', 'T']);
    expect(injectBoxBranch('merge', 'HEAD', [])).toEqual([]);
  });
});

describe('branchTargetUnresolved', () => {
  it('is true for branch-required ops with no resolvable branch', () => {
    expect(branchTargetUnresolved('create', ['--title', 'T'])).toBe(true);
    expect(branchTargetUnresolved('view', ['--json', 'x'])).toBe(true);
    expect(branchTargetUnresolved('merge', [])).toBe(true);
    // After injectBoxBranch failed to resolve a branch:
    expect(branchTargetUnresolved('view', injectBoxBranch('view', '', ['--json', 'x']))).toBe(true);
  });

  it('is false once a branch is present (injected or caller-supplied)', () => {
    expect(branchTargetUnresolved('create', ['--head', 'b'])).toBe(false);
    expect(branchTargetUnresolved('create', ['-H=feat/x'])).toBe(false);
    expect(branchTargetUnresolved('view', ['42'])).toBe(false);
    expect(branchTargetUnresolved('merge', injectBoxBranch('merge', 'agentbox/box-one', []))).toBe(
      false,
    );
  });

  it('is false for list (bare list-all is allowed) and checkout (own ref)', () => {
    expect(branchTargetUnresolved('list', [])).toBe(false);
    expect(branchTargetUnresolved('list', ['--json', 'x'])).toBe(false);
    expect(branchTargetUnresolved('checkout', [])).toBe(false);
  });
});

describe('parseWorktreeBranch', () => {
  const porcelain = [
    'worktree /Users/x/proj',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /home/vscode/.agentbox-worktrees/agentbox_box-one',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feature/x',
    '',
  ].join('\n');

  it('returns the live branch for the matching worktree path', () => {
    expect(
      parseWorktreeBranch(porcelain, '/home/vscode/.agentbox-worktrees/agentbox_box-one'),
    ).toBe('feature/x');
    expect(parseWorktreeBranch(porcelain, '/Users/x/proj')).toBe('main');
  });

  it('returns null when no block matches', () => {
    expect(parseWorktreeBranch(porcelain, '/home/vscode/.agentbox-worktrees/missing')).toBeNull();
  });

  it('returns empty string for a detached HEAD (no branch line)', () => {
    const detached = [
      'worktree /home/vscode/.agentbox-worktrees/agentbox_box-one',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeBranch(detached, '/home/vscode/.agentbox-worktrees/agentbox_box-one')).toBe(
      '',
    );
  });
});
