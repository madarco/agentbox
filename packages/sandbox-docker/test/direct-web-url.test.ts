import { describe, expect, it } from 'vitest';
import { skipWebProxyAlias } from '../src/direct-web-url.js';

/**
 * The create-time decision. Skipping the Portless WEB alias is the entire
 * mechanism — every producer of a box's web URL already falls back to the
 * directly published port when no alias is registered — so this predicate is
 * the one place the choice is made.
 */
describe('skipWebProxyAlias', () => {
  it('skips the alias for an agent that refuses proxied requests', () => {
    const lines: string[] = [];
    expect(skipWebProxyAlias(['openclaw'], (l) => lines.push(l))).toBe(true);
    // Silence would leave the user wondering where <box>.localhost went.
    expect(lines.join(' ')).toMatch(/published port directly/);
  });

  it('keeps the alias for an ordinary box, and says nothing', () => {
    const lines: string[] = [];
    expect(skipWebProxyAlias(['claude'], (l) => lines.push(l))).toBe(false);
    expect(lines).toEqual([]);
  });

  it('keeps the alias for a box created with no agents', () => {
    expect(skipWebProxyAlias(undefined, () => {})).toBe(false);
    expect(skipWebProxyAlias([], () => {})).toBe(false);
  });
});
