import { describe, expect, it } from 'vitest';
import {
  parseProviderSpec,
  providerNameOf,
  resolveCreateProviderSpec,
} from '../src/provider/spec.js';

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

describe('resolveCreateProviderSpec (a queued job with --remote-host resolves the remote engine)', () => {
  it('folds a remoteHost into a bare docker job as a remote-docker spec', () => {
    // The bug: without this a bare `docker` job + a host would build on the LOCAL
    // engine, silently ignoring the host the submitter asked for.
    expect(resolveCreateProviderSpec('docker', 'buildbox')).toBe('docker:buildbox');
    expect(providerNameOf(resolveCreateProviderSpec('docker', 'buildbox'))).toBe('remote-docker');
    // Same for an absent providerName (defaults to docker).
    expect(resolveCreateProviderSpec(undefined, 'buildbox')).toBe('docker:buildbox');
    // ...and the `remote-docker` name too.
    expect(providerNameOf(resolveCreateProviderSpec('remote-docker', 'buildbox'))).toBe(
      'remote-docker',
    );
  });

  it('leaves local docker local when no host is given', () => {
    expect(resolveCreateProviderSpec('docker', undefined)).toBe('docker');
    expect(providerNameOf(resolveCreateProviderSpec('docker', undefined))).toBe('docker');
    expect(resolveCreateProviderSpec(undefined, undefined)).toBe('docker');
  });

  it('passes a cloud provider through, ignoring a stray host', () => {
    // A cloud name never becomes remote-docker even if a host is set (nonsensical
    // input the CLI already warns about); the cloud provider wins.
    expect(resolveCreateProviderSpec('e2b', 'buildbox')).toBe('e2b');
    expect(resolveCreateProviderSpec('hetzner', undefined)).toBe('hetzner');
  });

  it('passes an explicit docker:<host> spec through unchanged', () => {
    // The host already lives in the spec; no separate remoteHost to fold in.
    expect(resolveCreateProviderSpec('docker:dev@10.0.0.9:2222', undefined)).toBe(
      'docker:dev@10.0.0.9:2222',
    );
  });
});
