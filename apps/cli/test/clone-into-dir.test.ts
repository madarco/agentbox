import { describe, expect, it } from 'vitest';
import { resolveIntoDir } from '../src/commands/clone.js';

/**
 * `agentbox clone --into` is resolved on the CLI side, against the CALLER's
 * working directory, before the request goes out.
 *
 * The regression this pins: when the clone's export+create moved behind
 * `POST /api/v1/boxes/:id/clone`, `--into` travelled as a raw string and was
 * `path.resolve`d inside the hub — a long-lived daemon started in some arbitrary
 * directory (and possibly a control box on another machine). `--into ./svc-hz`
 * then created the clone's workspace, and registered its project, somewhere
 * nobody asked for. A cwd is client state; it does not travel over an API, so
 * the client contributes the one thing only it knows.
 */
describe('resolveIntoDir', () => {
  it('makes a relative path absolute against the caller cwd', () => {
    expect(resolveIntoDir('./svc-hz', '/home/me/projects')).toBe('/home/me/projects/svc-hz');
    expect(resolveIntoDir('svc-hz', '/home/me/projects')).toBe('/home/me/projects/svc-hz');
    expect(resolveIntoDir('../svc', '/home/me/projects')).toBe('/home/me/svc');
  });

  it('leaves an already-absolute path alone', () => {
    expect(resolveIntoDir('/srv/clones/x', '/home/me')).toBe('/srv/clones/x');
  });

  it('never returns a relative path — the API refuses one', () => {
    for (const raw of ['./a', 'a', '../a', ' a/b ', '/abs']) {
      const out = resolveIntoDir(raw, '/home/me');
      expect(out, `${raw} must resolve to an absolute path`).toMatch(/^\//);
    }
  });

  it('treats absent / blank as no override, so the hub picks its own default', () => {
    expect(resolveIntoDir(undefined, '/home/me')).toBeUndefined();
    expect(resolveIntoDir('', '/home/me')).toBeUndefined();
    expect(resolveIntoDir('   ', '/home/me')).toBeUndefined();
  });
});

describe('resolveIntoDir — the $HOME half of the same class of bug', () => {
  it("refuses an un-expanded '~' rather than creating a directory named '~'", () => {
    // `~` means "home", and whose home is precisely what a path bound for
    // another machine cannot answer. `resolve()` would have turned '~/x' into
    // '<cwd>/~/x' — absolute, so the API would accept it, and a literal `~`
    // directory would appear.
    for (const raw of ['~', '~/clones', '~/a/b']) {
      expect(() => resolveIntoDir(raw, '/home/me'), raw).toThrow(/not expanded/);
    }
  });

  it("leaves a '~' that is not a home prefix alone", () => {
    expect(resolveIntoDir('~weird', '/home/me')).toBe('/home/me/~weird');
  });
});
