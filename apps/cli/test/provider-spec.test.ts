import { describe, expect, it } from 'vitest';
import { parseProviderSpec, providerNameOf } from '../src/provider/spec.js';

describe('parseProviderSpec', () => {
  it('leaves a bare provider name alone', () => {
    expect(parseProviderSpec('docker')).toEqual({ name: 'docker' });
    expect(parseProviderSpec('hetzner')).toEqual({ name: 'hetzner' });
    expect(parseProviderSpec('remote-docker')).toEqual({ name: 'remote-docker' });
  });

  it('reads `docker:<host>` as remote-docker pointed at that host', () => {
    expect(parseProviderSpec('docker:buildbox')).toEqual({
      name: 'remote-docker',
      remoteHost: 'buildbox',
    });
  });

  it('keeps the whole ssh destination, including a :port', () => {
    // Split on the FIRST colon: the rest is the destination, which has colons
    // of its own.
    expect(parseProviderSpec('docker:dev@10.0.0.9:2222')).toEqual({
      name: 'remote-docker',
      remoteHost: 'dev@10.0.0.9:2222',
    });
  });

  it("accepts the provider's real name as the base too", () => {
    expect(parseProviderSpec('remote-docker:buildbox')).toEqual({
      name: 'remote-docker',
      remoteHost: 'buildbox',
    });
  });

  it('does not reinterpret a colon on some other provider', () => {
    // Hand it back whole so the caller's unknown-provider error names it,
    // rather than silently resolving to something the user didn't ask for.
    expect(parseProviderSpec('hetzner:nbg1')).toEqual({ name: 'hetzner:nbg1' });
  });

  it('rejects a host-less spec', () => {
    expect(() => parseProviderSpec('docker:')).toThrow(/names no host/);
  });

  it('providerNameOf drops the host', () => {
    expect(providerNameOf('docker:buildbox')).toBe('remote-docker');
    expect(providerNameOf('daytona')).toBe('daytona');
  });
});
