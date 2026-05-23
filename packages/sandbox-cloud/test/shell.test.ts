import { describe, expect, it } from 'vitest';
import { quoteShellArg, quoteShellArgv } from '../src/shell.js';

describe('shell quoting', () => {
  it('passes safe identifiers through unquoted', () => {
    expect(quoteShellArg('foo-bar_baz/qux.txt')).toBe('foo-bar_baz/qux.txt');
  });

  it('single-quotes args with spaces or shell metachars', () => {
    expect(quoteShellArg('hello world')).toBe("'hello world'");
    expect(quoteShellArg('rm -rf /; echo pwned')).toBe("'rm -rf /; echo pwned'");
  });

  it("escapes embedded single-quotes via '\\'' interleaving", () => {
    expect(quoteShellArg("it's fine")).toBe("'it'\\''s fine'");
  });

  it('handles the empty string', () => {
    expect(quoteShellArg('')).toBe("''");
  });

  it('quoteShellArgv joins quoted args with spaces', () => {
    expect(quoteShellArgv(['git', 'commit', '-m', 'hi there'])).toBe(
      "git commit -m 'hi there'",
    );
  });
});
