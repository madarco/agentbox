import { describe, expect, it } from 'vitest';
import { destroyGate } from '../src/commands/control-plane.js';

/**
 * Cloud boxes the control box created keep running in their provider after it is
 * gone, and the hub's store is often the only record they exist — so a non-empty
 * list is a hard stop. An unreachable hub is deliberately NOT: a deploy that
 * never came up is the most common thing to want deleted, and refusing there
 * would leave no way to clean up at all.
 */
describe('destroyGate', () => {
  const box = { id: 'b1', name: 'demo', provider: 'e2b', state: 'running' };

  it('allows destroying a hub with no boxes, with nothing to warn about', () => {
    expect(destroyGate({ kind: 'boxes', rows: [] }, false)).toEqual({
      allowed: true,
      orphanCount: 0,
      orphans: [],
      note: null,
    });
  });

  it('refuses while boxes are registered', () => {
    const g = destroyGate({ kind: 'boxes', rows: [box, { ...box, id: 'b2' }] }, false);
    expect(g.allowed).toBe(false);
    expect(g.orphanCount).toBe(2);
  });

  it('proceeds with --force, but says what is being orphaned', () => {
    const g = destroyGate({ kind: 'boxes', rows: [box] }, true);
    expect(g.allowed).toBe(true);
    expect(g.note).toContain('orphaned');
    expect(g.note).toContain('--force');
  });

  it('does not block on an unreachable hub — a broken deploy must stay deletable', () => {
    const g = destroyGate({ kind: 'unreachable', reason: 'fetch failed' }, false);
    expect(g.allowed).toBe(true);
    expect(g.orphanCount).toBe(0);
    expect(g.note).toContain('could not be listed');
    expect(g.note).toContain('fetch failed');
  });

  it('carries the reason through so the prompt can show why the list is unknown', () => {
    const g = destroyGate({ kind: 'unreachable', reason: 'no /api/v1 key configured' }, true);
    expect(g.note).toContain('no /api/v1 key configured');
  });
});

/**
 * A local `docker` box runs on this machine against the host's own `.git` and is
 * never handed to the control box, so losing the hub cannot orphan it. Gating on
 * one made an exposed hub refuse to stand down because of a container sitting
 * right next to it — hit live on the first `hub unexpose`.
 */
describe('destroyGate ignores boxes that cannot be orphaned', () => {
  const docker = { id: 'd1', name: 'local', provider: 'docker', state: 'running' };
  const cloud = { id: 'c1', name: 'remote', provider: 'e2b', state: 'running' };

  it('allows teardown when only local docker boxes are registered', () => {
    const g = destroyGate({ kind: 'boxes', rows: [docker, { ...docker, id: 'd2' }] }, false);
    expect(g.allowed).toBe(true);
    expect(g.orphanCount).toBe(0);
    expect(g.orphans).toEqual([]);
  });

  it('still refuses for a cloud box, and reports only the real orphans', () => {
    const g = destroyGate({ kind: 'boxes', rows: [docker, cloud] }, false);
    expect(g.allowed).toBe(false);
    expect(g.orphanCount).toBe(1);
    expect(g.orphans).toEqual([cloud]);
  });

  it('does NOT exempt remote-docker — that box lives on another machine', () => {
    const g = destroyGate(
      { kind: 'boxes', rows: [{ id: 'r1', provider: 'remote-docker', state: 'running' }] },
      false,
    );
    expect(g.allowed).toBe(false);
    expect(g.orphanCount).toBe(1);
  });
});
