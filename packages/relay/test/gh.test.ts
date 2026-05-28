import { describe, expect, it } from 'vitest';
import { injectPrCreateHead } from '../src/gh.js';

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

  it('leaves args unchanged when no usable branch resolved', () => {
    expect(injectPrCreateHead('create', undefined, ['--title', 'T'])).toEqual(['--title', 'T']);
    expect(injectPrCreateHead('create', '', ['--title', 'T'])).toEqual(['--title', 'T']);
    expect(injectPrCreateHead('create', 'HEAD', ['--title', 'T'])).toEqual(['--title', 'T']);
  });
});
