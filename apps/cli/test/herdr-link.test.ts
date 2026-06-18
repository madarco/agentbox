import { describe, expect, it } from 'vitest';
import { parseHerdrLink } from '../src/commands/herdr.js';

describe('parseHerdrLink', () => {
  it('parses agentbox://<verb>/<box>', () => {
    expect(parseHerdrLink('agentbox://web/my-box')).toEqual({ verb: 'web', box: 'my-box' });
  });

  it('url-decodes the box segment', () => {
    expect(parseHerdrLink('agentbox://web/feat%2Fx-78b94c78')).toEqual({
      verb: 'web',
      box: 'feat/x-78b94c78',
    });
  });

  it('returns null for non-matching / empty input', () => {
    expect(parseHerdrLink(undefined)).toBeNull();
    expect(parseHerdrLink('')).toBeNull();
    expect(parseHerdrLink('https://example.com')).toBeNull();
    expect(parseHerdrLink('agentbox://web')).toBeNull();
    expect(parseHerdrLink('agentbox://web/')).toBeNull();
  });
});
