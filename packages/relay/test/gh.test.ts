import { describe, expect, it } from 'vitest';
import {
  GH_PR_READ_ONLY_OPS,
  GH_RUN_READ_ONLY_OPS,
  injectPrCreateHead,
  isAllowedGhApiEndpoint,
  isGhPrOp,
  isGhRunOp,
  isWriteAllowedGhApiEndpoint,
  prCreateNeedsHead,
  refuseGhApiCall,
} from '../src/gh.js';

describe('injectPrCreateHead', () => {
  it('prepends --head <branch> for create when none was passed', () => {
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['--title', 'T'])).toEqual([
      '--head',
      'agentbox/box-one',
      '--title',
      'T',
    ]);
  });

  it('is a no-op for non-create ops', () => {
    expect(injectPrCreateHead('view', 'agentbox/box-one', ['7'])).toEqual(['7']);
    expect(injectPrCreateHead('merge', 'agentbox/box-one', ['42'])).toEqual(['42']);
  });

  it('does not double-inject when --head is already present', () => {
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['--head', 'feat/x'])).toEqual([
      '--head',
      'feat/x',
    ]);
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['--head=feat/x'])).toEqual([
      '--head=feat/x',
    ]);
  });

  it('does not double-inject when the -H shorthand is already present', () => {
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['-H', 'feat/x'])).toEqual([
      '-H',
      'feat/x',
    ]);
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['-Hfeat/x'])).toEqual(['-Hfeat/x']);
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['-H=feat/x'])).toEqual(['-H=feat/x']);
  });

  it('leaves args unchanged when no usable branch resolved', () => {
    expect(injectPrCreateHead('create', undefined, ['--title', 'T'])).toEqual(['--title', 'T']);
    expect(injectPrCreateHead('create', '', ['--title', 'T'])).toEqual(['--title', 'T']);
    expect(injectPrCreateHead('create', 'HEAD', ['--title', 'T'])).toEqual(['--title', 'T']);
  });
});

describe('prCreateNeedsHead', () => {
  it('is true for a create that still has no --head', () => {
    expect(prCreateNeedsHead('create', ['--title', 'T'])).toBe(true);
    // After injectPrCreateHead failed to resolve a branch:
    expect(prCreateNeedsHead('create', injectPrCreateHead('create', '', ['--title', 'T']))).toBe(
      true,
    );
  });

  it('is false once --head is present (injected or caller-supplied)', () => {
    expect(prCreateNeedsHead('create', ['--head', 'agentbox/box-one', '--title', 'T'])).toBe(false);
    expect(prCreateNeedsHead('create', ['--head=feat/x'])).toBe(false);
    expect(
      prCreateNeedsHead('create', injectPrCreateHead('create', 'agentbox/box-one', ['--title', 'T'])),
    ).toBe(false);
  });

  it('is false when the -H shorthand supplied a head (no false refusal)', () => {
    expect(prCreateNeedsHead('create', ['-H', 'feat/x', '--title', 'T'])).toBe(false);
    expect(prCreateNeedsHead('create', ['-Hfeat/x'])).toBe(false);
    expect(prCreateNeedsHead('create', ['-H=feat/x'])).toBe(false);
  });

  it('is false for non-create ops', () => {
    expect(prCreateNeedsHead('view', ['7'])).toBe(false);
    expect(prCreateNeedsHead('merge', ['42'])).toBe(false);
  });
});

describe('gh pr diff / checks', () => {
  it('are recognized ops', () => {
    expect(isGhPrOp('diff')).toBe(true);
    expect(isGhPrOp('checks')).toBe(true);
  });

  it('are read-only (no prompt)', () => {
    expect(GH_PR_READ_ONLY_OPS.has('diff')).toBe(true);
    expect(GH_PR_READ_ONLY_OPS.has('checks')).toBe(true);
  });
});

describe('isGhRunOp', () => {
  it('accepts list / view / rerun', () => {
    expect(isGhRunOp('list')).toBe(true);
    expect(isGhRunOp('view')).toBe(true);
    expect(isGhRunOp('rerun')).toBe(true);
  });

  it('rejects watch and anything else', () => {
    expect(isGhRunOp('watch')).toBe(false);
    expect(isGhRunOp('cancel')).toBe(false);
    expect(isGhRunOp('')).toBe(false);
  });
});

describe('GH_RUN_READ_ONLY_OPS', () => {
  it('covers list / view but not rerun', () => {
    expect(GH_RUN_READ_ONLY_OPS.has('list')).toBe(true);
    expect(GH_RUN_READ_ONLY_OPS.has('view')).toBe(true);
    expect(GH_RUN_READ_ONLY_OPS.has('rerun')).toBe(false);
  });
});

describe('isAllowedGhApiEndpoint', () => {
  it('matches the PR comments endpoint with or without a leading slash', () => {
    expect(isAllowedGhApiEndpoint('/repos/o/r/pulls/5/comments')).toBe(true);
    expect(isAllowedGhApiEndpoint('repos/o/r/pulls/5/comments')).toBe(true);
  });

  it('allows a trailing GET query string', () => {
    expect(isAllowedGhApiEndpoint('repos/o/r/pulls/5/comments?per_page=50')).toBe(true);
  });

  it('matches the review-comment replies endpoint', () => {
    expect(isAllowedGhApiEndpoint('repos/o/r/pulls/5/comments/42/replies')).toBe(true);
  });

  it('rejects sibling / unrelated endpoints', () => {
    expect(isAllowedGhApiEndpoint('repos/o/r/issues/5/comments')).toBe(false);
    expect(isAllowedGhApiEndpoint('repos/o/r/pulls/5/merge')).toBe(false);
    expect(isAllowedGhApiEndpoint('repos/o/r/pulls/abc/comments')).toBe(false);
    expect(isAllowedGhApiEndpoint('user')).toBe(false);
    expect(isAllowedGhApiEndpoint('')).toBe(false);
  });
});

describe('isWriteAllowedGhApiEndpoint', () => {
  it('covers the PR review-comment endpoints (with leading slash variance)', () => {
    expect(isWriteAllowedGhApiEndpoint('repos/o/r/pulls/5/comments')).toBe(true);
    expect(isWriteAllowedGhApiEndpoint('/repos/o/r/pulls/5/comments')).toBe(true);
    expect(isWriteAllowedGhApiEndpoint('repos/o/r/pulls/5/comments/42/replies')).toBe(true);
  });

  it('excludes non-comment and conversation-comment endpoints', () => {
    expect(isWriteAllowedGhApiEndpoint('repos/o/r/pulls/5')).toBe(false);
    expect(isWriteAllowedGhApiEndpoint('repos/o/r/issues/5/comments')).toBe(false);
  });
});

describe('refuseGhApiCall', () => {
  const COMMENTS = 'repos/o/r/pulls/5/comments';
  const REPLIES = 'repos/o/r/pulls/5/comments/42/replies';

  it('allows GET (default and explicit) on an allowlisted endpoint', () => {
    expect(refuseGhApiCall(COMMENTS, [])).toBeNull();
    expect(refuseGhApiCall(COMMENTS, ['--jq', '.[].body'])).toBeNull();
    expect(refuseGhApiCall(COMMENTS, ['--paginate'])).toBeNull();
    expect(refuseGhApiCall(COMMENTS, ['-X', 'GET'])).toBeNull();
    expect(refuseGhApiCall(COMMENTS, ['--method=get'])).toBeNull();
    expect(refuseGhApiCall(COMMENTS, ['-XGET'])).toBeNull();
  });

  it('allows POST to comment endpoints (explicit, field-implied, and glued forms)', () => {
    expect(refuseGhApiCall(COMMENTS, ['-X', 'POST', '-f', 'body=hi'])).toBeNull();
    expect(refuseGhApiCall(COMMENTS, ['-f', 'body=hi'])).toBeNull(); // field-implied POST
    expect(refuseGhApiCall(COMMENTS, ['-fbody=hi'])).toBeNull(); // glued field
    expect(refuseGhApiCall(COMMENTS, ['-XPOST', '-Fline=10'])).toBeNull();
    expect(refuseGhApiCall(REPLIES, ['-f', 'body=hi'])).toBeNull();
  });

  it('refuses POST to an endpoint not on the write allowlist', () => {
    expect(refuseGhApiCall('repos/o/r/pulls/5', ['-X', 'POST'])?.exitCode).toBe(65);
    expect(refuseGhApiCall('repos/o/r/issues/5/comments', ['-f', 'body=hi'])?.exitCode).toBe(65);
  });

  it('treats a method-looking token bound to a field flag as POST, not GET', () => {
    // pflag binds `-X=GET` as `-f`'s value (so gh POSTs); the parser must
    // consume the field value and not misread it as `--method GET`. On a
    // non-write endpoint that means refusal, not a silent GET bypass.
    expect(refuseGhApiCall('repos/o/r/pulls/5', ['-f', '-X=GET'])?.exitCode).toBe(65);
    expect(refuseGhApiCall('repos/o/r/pulls/5', ['--field', '-X=GET'])?.exitCode).toBe(65);
    // And on a write-allowed endpoint it's correctly allowed (POST).
    expect(refuseGhApiCall('repos/o/r/pulls/5/comments', ['-f', '-X=GET'])).toBeNull();
  });

  it('refuses non-GET/POST methods even on comment endpoints', () => {
    expect(refuseGhApiCall(COMMENTS, ['-X', 'PATCH', '-f', 'body=hi'])?.exitCode).toBe(65);
    expect(refuseGhApiCall(COMMENTS, ['-X', 'DELETE'])?.exitCode).toBe(65);
    expect(refuseGhApiCall(COMMENTS, ['--method=put'])?.exitCode).toBe(65);
  });

  it('refuses --input (stdin/file body cannot cross the relay)', () => {
    expect(refuseGhApiCall(COMMENTS, ['--input', '-'])?.exitCode).toBe(65);
    expect(refuseGhApiCall(COMMENTS, ['--input=/tmp/x'])?.exitCode).toBe(65);
    expect(refuseGhApiCall(COMMENTS, ['--input', '-'])?.stderr).toMatch(/--input/);
  });
});
