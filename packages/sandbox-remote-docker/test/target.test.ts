import { describe, expect, it } from 'vitest';
import {
  containerNameFor,
  makeSandboxId,
  parseRemoteTarget,
  parseSandboxId,
  sshTargetFor,
} from '../src/target.js';

describe('parseRemoteTarget', () => {
  it('accepts a bare ~/.ssh/config alias, leaving user and port to ssh', () => {
    expect(parseRemoteTarget('buildbox')).toEqual({ host: 'buildbox', spec: 'buildbox' });
  });

  it('splits user@host', () => {
    expect(parseRemoteTarget('dev@10.0.0.9')).toEqual({
      host: '10.0.0.9',
      user: 'dev',
      spec: 'dev@10.0.0.9',
    });
  });

  it('splits a trailing :port', () => {
    expect(parseRemoteTarget('dev@10.0.0.9:2222')).toEqual({
      host: '10.0.0.9',
      user: 'dev',
      port: 2222,
      spec: 'dev@10.0.0.9:2222',
    });
  });

  it('treats a non-numeric colon tail as part of the host, not a port', () => {
    // An IPv6 literal has colons but no port unless bracketed.
    const t = parseRemoteTarget('fe80::1');
    expect(t.host).toBe('fe80::1');
    expect(t.port).toBeUndefined();
  });

  it('rejects an empty destination', () => {
    expect(() => parseRemoteTarget('  ')).toThrow(/empty SSH destination/);
  });

  it('rejects a destination containing "/" (it separates the container in a sandbox id)', () => {
    expect(() => parseRemoteTarget('host/extra')).toThrow(/invalid SSH destination/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseRemoteTarget('host:99999')).toThrow(/invalid SSH port/);
  });
});

describe('sandbox ids', () => {
  it('round-trips destination + container', () => {
    const id = makeSandboxId('dev@10.0.0.9:2222', 'agentbox-brave-otter');
    expect(id).toBe('dev@10.0.0.9:2222/agentbox-brave-otter');
    const parsed = parseSandboxId(id);
    expect(parsed.container).toBe('agentbox-brave-otter');
    expect(parsed.target.host).toBe('10.0.0.9');
    expect(parsed.target.user).toBe('dev');
    expect(parsed.target.port).toBe(2222);
    // The spec must survive verbatim — it is what a later `ssh` is handed.
    expect(parsed.target.spec).toBe('dev@10.0.0.9:2222');
  });

  it('rejects a malformed id rather than guessing', () => {
    expect(() => parseSandboxId('no-slash-here')).toThrow(/malformed sandbox id/);
    expect(() => parseSandboxId('/leading')).toThrow(/malformed sandbox id/);
    expect(() => parseSandboxId('trailing/')).toThrow(/malformed sandbox id/);
  });
});

describe('sshTargetFor', () => {
  it("emits no identity and no known_hosts — the user's ~/.ssh/config owns both", () => {
    const t = sshTargetFor(parseRemoteTarget('buildbox'));
    expect(t.identity).toBeUndefined();
    expect(t.knownHosts).toBeUndefined();
    expect(t.user).toBeUndefined();
    expect(t.host).toBe('buildbox');
  });

  it('carries the ControlMaster socket when given one', () => {
    const t = sshTargetFor(parseRemoteTarget('dev@box'), '/tmp/ctl.sock');
    expect(t.controlPath).toBe('/tmp/ctl.sock');
  });
});

describe('containerNameFor', () => {
  it("matches the docker provider's naming", () => {
    expect(containerNameFor('brave-otter')).toBe('agentbox-brave-otter');
  });
});

describe('IPv6 destinations', () => {
  it('reads a bracketed literal with a port', () => {
    const t = parseRemoteTarget('dev@[fe80::1]:2222');
    expect(t).toEqual({ host: 'fe80::1', user: 'dev', port: 2222, spec: 'dev@[fe80::1]:2222' });
  });

  it('reads a bracketed literal without a port', () => {
    expect(parseRemoteTarget('[fe80::1]').host).toBe('fe80::1');
  });
});
