import { describe, expect, it } from 'vitest';
import {
  CarryConfigError,
  parseCarryRaw,
  parseCarrySection,
} from '../src/carry.js';
import { parseConfig } from '../src/config.js';

describe('parseCarrySection', () => {
  it('returns empty for empty or absent doc / missing carry key', () => {
    expect(parseCarrySection('')).toEqual([]);
    expect(parseCarrySection('services: {}')).toEqual([]);
    expect(parseCarrySection('carry: []')).toEqual([]);
  });

  it('parses string shorthand: src = dest', () => {
    const items = parseCarrySection(`carry:\n  - ~/.agentbox/secrets.env\n`);
    expect(items).toEqual([
      { src: '~/.agentbox/secrets.env', dest: '~/.agentbox/secrets.env', optional: false },
    ]);
  });

  it('parses string shorthand with explicit src=dest split on FIRST equals', () => {
    const items = parseCarrySection(
      `carry:\n  - ./scripts/seed.sh=/workspace/scripts/seed.sh\n  - /tmp/foo=/box/bar=baz\n`,
    );
    expect(items[0]).toEqual({
      src: './scripts/seed.sh',
      dest: '/workspace/scripts/seed.sh',
      optional: false,
    });
    // Second '=' is preserved in dest.
    expect(items[1]).toEqual({ src: '/tmp/foo', dest: '/box/bar=baz', optional: false });
  });

  it('parses mapping form with mode (number, octal string, "0o" prefix) and optional', () => {
    const items = parseCarrySection(`carry:
  - src: ~/.agentbox/secrets.env
    dest: ~/.agentbox/secrets.env
    mode: 0o600
    optional: true
  - src: ~/.codex/auth.json
    mode: "0600"
  - src: ~/.config/hcloud/cli.toml
    mode: "600"
`);
    expect(items[0]).toEqual({
      src: '~/.agentbox/secrets.env',
      dest: '~/.agentbox/secrets.env',
      mode: 0o600,
      optional: true,
    });
    expect(items[1]?.mode).toBe(0o600);
    expect(items[2]?.mode).toBe(0o600);
    // dest defaults to src when src is absolute / ~/
    expect(items[1]?.dest).toBe('~/.codex/auth.json');
  });

  it('rejects bare relative src (must start with /, ~/, or ./)', () => {
    expect(() => parseCarrySection(`carry:\n  - secrets.env\n`)).toThrow(CarryConfigError);
    expect(() => parseCarrySection(`carry:\n  - src: secrets.env\n`)).toThrow(/must start with/);
  });

  it('rejects ./ shorthand without explicit dest', () => {
    expect(() => parseCarrySection(`carry:\n  - ./.agentbox-dev/\n`)).toThrow(
      /must specify an explicit dest/,
    );
  });

  it('rejects mapping with ./ src and no dest', () => {
    expect(() => parseCarrySection(`carry:\n  - src: ./.agentbox-dev/\n`)).toThrow(
      /dest is required/,
    );
  });

  it('rejects dest that is not / or ~/', () => {
    expect(() =>
      parseCarrySection(`carry:\n  - src: /tmp/x\n    dest: tmp/x\n`),
    ).toThrow(/must start with \/ or ~\//);
  });

  it('rejects unknown per-entry keys', () => {
    expect(() =>
      parseCarrySection(`carry:\n  - src: /a\n    dest: /b\n    chown: vscode\n`),
    ).toThrow(/unknown key "chown"/);
  });

  it('rejects non-octal mode', () => {
    expect(() =>
      parseCarrySection(`carry:\n  - src: /a\n    dest: /b\n    mode: "rw-"\n`),
    ).toThrow(/must be an octal number/);
    expect(() =>
      parseCarrySection(`carry:\n  - src: /a\n    dest: /b\n    mode: 99999\n`),
    ).toThrow(/between 0 and 0o7777/);
  });

  it('rejects non-array carry', () => {
    expect(() => parseCarrySection(`carry:\n  foo: bar\n`)).toThrow(/must be a list/);
  });

  it('rejects non-string/non-mapping items', () => {
    expect(() => parseCarrySection(`carry:\n  - 42\n`)).toThrow(/must be a string or mapping/);
  });

  it('mode field is omitted when not declared', () => {
    const items = parseCarrySection(`carry:\n  - src: /a\n    dest: /b\n`);
    expect(items[0]).toEqual({ src: '/a', dest: '/b', optional: false });
    expect('mode' in items[0]!).toBe(false);
  });

  it('parses user as number, numeric string, both accepted', () => {
    const items = parseCarrySection(`carry:
  - src: /a
    dest: /b
    user: 1000
  - src: /c
    dest: /d
    user: "1000"
  - src: /e
    dest: /f
    user: 0
`);
    expect(items[0]?.user).toBe(1000);
    expect(items[1]?.user).toBe(1000);
    expect(items[2]?.user).toBe(0);
  });

  it('rejects non-numeric user (usernames not supported)', () => {
    expect(() =>
      parseCarrySection(`carry:\n  - src: /a\n    dest: /b\n    user: vscode\n`),
    ).toThrow(/numeric uid/);
  });

  it('rejects negative or > 65535 user', () => {
    expect(() =>
      parseCarrySection(`carry:\n  - src: /a\n    dest: /b\n    user: -1\n`),
    ).toThrow(/non-negative/);
    expect(() =>
      parseCarrySection(`carry:\n  - src: /a\n    dest: /b\n    user: 99999\n`),
    ).toThrow(/between 0 and 65535/);
  });

  it('user field is omitted when not declared', () => {
    const items = parseCarrySection(`carry:\n  - src: /a\n    dest: /b\n`);
    expect('user' in items[0]!).toBe(false);
  });
});

describe('parseCarryRaw', () => {
  it('passes through pre-parsed structures', () => {
    expect(parseCarryRaw(undefined)).toEqual([]);
    expect(parseCarryRaw(null)).toEqual([]);
    expect(parseCarryRaw([])).toEqual([]);
    expect(parseCarryRaw(['~/.agentbox/secrets.env'])).toEqual([
      { src: '~/.agentbox/secrets.env', dest: '~/.agentbox/secrets.env', optional: false },
    ]);
  });
});

describe('config schema drift', () => {
  // Ensures `carry` is tolerated as a top-level key in the supervisor's
  // parseConfig — the supervisor MUST not reject yaml that declares it,
  // even though it does not act on it.
  it('parseConfig tolerates a carry: block alongside services/tasks', () => {
    const cfg = parseConfig(`
carry:
  - ~/.agentbox/secrets.env
tasks:
  install:
    command: pnpm install
`);
    expect(cfg.tasks).toHaveLength(1);
    expect(cfg.tasks[0]?.name).toBe('install');
    // parseConfig does not surface carry; it just doesn't reject it.
  });
});
