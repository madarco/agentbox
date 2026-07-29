import { describe, expect, it } from 'vitest';
import type { HubTarget } from '../src/commands/hub.js';
import {
  exitCodeForApiError,
  hubApiTargetFrom,
  isSupportedApiVersion,
} from '../src/control-plane/with-hub.js';

describe('hubApiTargetFrom (target resolution, all three shapes)', () => {
  it('remote configured control box → apiKey is its token', () => {
    const t: HubTarget = { mode: 'remote', url: 'https://plane.example', token: 'KEY' };
    expect(hubApiTargetFrom(t)).toEqual({ ok: true, url: 'https://plane.example', apiKey: 'KEY' });
  });

  it('remote exposed loopback (hub expose) → apiKey is AGENTBOX_HUB_API_KEY', () => {
    const t: HubTarget = { mode: 'remote', url: 'http://127.0.0.1:8787', token: 'EXPOSED_KEY' };
    expect(hubApiTargetFrom(t)).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8787',
      apiKey: 'EXPOSED_KEY',
    });
  });

  it('local hub → apiKey is the local hub token', () => {
    const t: HubTarget = { mode: 'local', url: 'http://127.0.0.1:8787', token: 'LOCAL_TOKEN' };
    expect(hubApiTargetFrom(t)).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8787',
      apiKey: 'LOCAL_TOKEN',
    });
  });

  it('local hub with no token (not running yet) → the autostart signal', () => {
    const t: HubTarget = { mode: 'local', url: 'http://127.0.0.1:8787', token: '' };
    expect(hubApiTargetFrom(t)).toEqual({ ok: false, reason: 'no-token', mode: 'local' });
  });

  it('remote hub with no key configured → not ok, remote', () => {
    const t: HubTarget = { mode: 'remote', url: 'https://plane.example', token: '' };
    expect(hubApiTargetFrom(t)).toEqual({ ok: false, reason: 'no-token', mode: 'remote' });
  });
});

describe('isSupportedApiVersion (version gate)', () => {
  it('accepts a version this CLI speaks', () => {
    expect(isSupportedApiVersion('v1')).toBe(true);
  });

  it('rejects an unknown version', () => {
    expect(isSupportedApiVersion('v2')).toBe(false);
  });

  it('rejects a hub that reports no version', () => {
    expect(isSupportedApiVersion(undefined)).toBe(false);
  });
});

describe('exitCodeForApiError (error mapping)', () => {
  it('maps each known API error code to a distinct exit code', () => {
    expect(exitCodeForApiError('not_found')).toBe(2);
    expect(exitCodeForApiError('unauthorized')).toBe(3);
    expect(exitCodeForApiError('invalid_request')).toBe(4);
    expect(exitCodeForApiError('conflict')).toBe(5);
    expect(exitCodeForApiError('backend_unavailable')).toBe(6);
  });

  it('falls back to 1 for internal / unmapped codes', () => {
    expect(exitCodeForApiError('internal')).toBe(1);
    expect(exitCodeForApiError('something_new')).toBe(1);
  });
});
