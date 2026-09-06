import { describe, expect, it } from 'vitest';
import type { BoxStatus } from '@agentbox/ctl';
import { webProxyWarning } from '../src/lib/web-proxy-warning.js';

/**
 * Absent must never read as healthy.
 *
 * `webProxy` is an additive field on a schema-1 snapshot, so every box whose
 * ctl was baked before it simply lacks it. If that were treated as "no error",
 * fine — it is. The trap is the opposite reading: an EMPTY error string, which
 * a naive truthiness check on the object would turn into a warning on a working
 * box, and warnings that fire on working boxes stop being read.
 */
function status(webProxy?: BoxStatus['webProxy']): BoxStatus {
  return {
    schema: 1,
    boxId: 'b1',
    timestamp: '2026-09-06T00:00:00.000Z',
    services: [],
    tasks: [],
    ports: [],
    ...(webProxy === undefined ? {} : { webProxy }),
  };
}

describe('webProxyWarning', () => {
  it('warns, naming the bind failure, when the forwarder is not listening', () => {
    const w = webProxyWarning(
      status({ port: 80, target: 18789, error: 'listen :80 failed: EADDRINUSE' }),
    );
    expect(w).toContain('EADDRINUSE');
    // The user's actual question is "why doesn't the URL work" — say that, not
    // just the errno.
    expect(w).toContain('will not reach the service');
  });

  it('stays quiet for a healthy forwarder', () => {
    expect(webProxyWarning(status({ port: 8080, target: 18789 }))).toBeNull();
  });

  it('stays quiet when nothing is exposed', () => {
    expect(webProxyWarning(status({ port: 80, target: null }))).toBeNull();
  });

  it('stays quiet on a snapshot from a ctl that predates the field', () => {
    expect(webProxyWarning(status())).toBeNull();
  });

  it('stays quiet with no snapshot at all', () => {
    // A cloud box that has not pushed one yet, or a stopped box.
    expect(webProxyWarning(null)).toBeNull();
    expect(webProxyWarning(undefined)).toBeNull();
  });

  it('treats an empty error string as no error', () => {
    expect(webProxyWarning(status({ port: 80, target: 18789, error: '' }))).toBeNull();
  });
});
