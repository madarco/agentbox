import { describe, expect, it } from 'vitest';
import { injectPrCreateHead, prCreateNeedsHead } from '../src/gh.js';

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
