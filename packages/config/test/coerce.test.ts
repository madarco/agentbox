import { describe, expect, it } from 'vitest';
import { coerceFromString } from '../src/parse.js';
import { UserConfigError } from '../src/types.js';

describe('coerceFromString', () => {
  it('parses booleans (true/yes/1/on)', () => {
    expect(coerceFromString('box.hostSnapshot', 'true')).toBe(true);
    expect(coerceFromString('box.hostSnapshot', 'yes')).toBe(true);
    expect(coerceFromString('box.hostSnapshot', '1')).toBe(true);
    expect(coerceFromString('box.hostSnapshot', 'on')).toBe(true);
    expect(coerceFromString('box.hostSnapshot', 'TRUE')).toBe(true);
  });

  it('parses booleans (false/no/0/off)', () => {
    expect(coerceFromString('box.hostSnapshot', 'false')).toBe(false);
    expect(coerceFromString('box.hostSnapshot', 'no')).toBe(false);
    expect(coerceFromString('box.hostSnapshot', '0')).toBe(false);
    expect(coerceFromString('box.hostSnapshot', 'off')).toBe(false);
  });

  it('rejects non-bool strings for bool keys', () => {
    expect(() => coerceFromString('box.hostSnapshot', 'maybe')).toThrow(UserConfigError);
  });

  it('parses integers', () => {
    expect(coerceFromString('code.timeoutMs', '120000')).toBe(120000);
    expect(coerceFromString('code.timeoutMs', '0')).toBe(0);
    expect(coerceFromString('code.timeoutMs', '-5')).toBe(-5);
  });

  it('rejects non-integers for int keys', () => {
    expect(() => coerceFromString('code.timeoutMs', '120.5')).toThrow(UserConfigError);
    expect(() => coerceFromString('code.timeoutMs', 'abc')).toThrow(UserConfigError);
  });

  it('passes strings through unchanged', () => {
    expect(coerceFromString('box.image', 'agentbox/box:dev')).toBe('agentbox/box:dev');
  });

  it('rejects empty strings for string keys', () => {
    expect(() => coerceFromString('box.image', '')).toThrow(UserConfigError);
  });

  it('accepts valid enum values', () => {
    expect(coerceFromString('engine.kind', 'orbstack')).toBe('orbstack');
    expect(coerceFromString('code.ide', 'cursor')).toBe('cursor');
  });

  it('rejects invalid enum values', () => {
    expect(() => coerceFromString('engine.kind', 'podman')).toThrow(UserConfigError);
    expect(() => coerceFromString('browser.default', 'firefox')).toThrow(UserConfigError);
  });

  it('rejects unknown keys', () => {
    expect(() => coerceFromString('foo.bar', 'baz')).toThrow(UserConfigError);
    expect(() => coerceFromString('flatkey', 'x')).toThrow(UserConfigError);
    expect(() => coerceFromString('box.snorshot', 'true')).toThrow(UserConfigError);
  });
});

describe('box.provider accepts an engine spec', () => {
  // `docker:<alias>` names an engine, not a provider — but it resolves to
  // remote-docker, and a control box's own engine (`docker:hub`) has to be
  // settable as the default. Everything else stays an exact enum match.
  it('coerces a docker:/remote-docker: spec', () => {
    expect(coerceFromString('box.provider', 'docker:hub')).toBe('docker:hub');
    expect(coerceFromString('box.provider', 'remote-docker:buildbox')).toBe(
      'remote-docker:buildbox',
    );
  });

  it('still accepts the plain provider names', () => {
    expect(coerceFromString('box.provider', 'e2b')).toBe('e2b');
  });

  it('rejects a non-provider base, an unknown name, and an empty host', () => {
    expect(() => coerceFromString('box.provider', 'hetzner:nbg1')).toThrow(UserConfigError);
    expect(() => coerceFromString('box.provider', 'nonsense')).toThrow(UserConfigError);
    expect(() => coerceFromString('box.provider', 'docker:')).toThrow(UserConfigError);
  });
});
