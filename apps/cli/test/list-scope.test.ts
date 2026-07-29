import { describe, expect, it } from 'vitest';
import type { HubApiBox } from '../src/control-plane/hub-api-client.js';
import { boxInProject, isCrossMachineHub } from '../src/commands/list.js';

/** Minimal HubApiBox fixture — boxInProject only reads projectRoot + originUrl. */
function box(p: Partial<HubApiBox>): HubApiBox {
  return { id: 'b', name: 'b', task: 'b', provider: 'docker', status: 'running', branch: '', ...p };
}

const LAPTOP = '/Users/me/agentbox';
const ORIGIN = 'git@github.com:madarco/agentbox.git';

describe('boxInProject', () => {
  const local = { root: LAPTOP, origin: ORIGIN, remote: false };
  const rmt = { root: LAPTOP, origin: ORIGIN, remote: true };

  it('matches a box in the same folder (local hub)', () => {
    expect(boxInProject(box({ projectRoot: LAPTOP }), local)).toBe(true);
  });

  it('keeps two same-origin folders apart on a local hub (folder-based scoping)', () => {
    // A box whose projectRoot is a DIFFERENT local folder of the same repo must
    // not leak into this folder's scoped listing.
    const b = box({ projectRoot: '/Users/me/agentbox-2', originUrl: ORIGIN });
    expect(boxInProject(b, local)).toBe(false);
  });

  it('scopes a registered box with no local projectRoot by origin (any mode)', () => {
    const b = box({ projectRoot: undefined, originUrl: ORIGIN });
    expect(boxInProject(b, local)).toBe(true);
    expect(boxInProject(b, rmt)).toBe(true);
  });

  it('matches a remote hub box by origin despite a foreign projectRoot', () => {
    // The regression: on a REMOTE hub the box carries the control box's absolute
    // projectRoot, which never equals the laptop's root — so it must match on
    // repo identity instead, or project-scoped `ls` silently drops it.
    const b = box({ projectRoot: '/home/ci/agentbox', originUrl: ORIGIN });
    expect(boxInProject(b, rmt)).toBe(true);
    // The same box on a LOCAL hub (foreign projectRoot, not remote) stays out.
    expect(boxInProject(b, local)).toBe(false);
  });

  it('normalizes ssh vs https origins when matching', () => {
    const b = box({
      projectRoot: '/home/ci/agentbox',
      originUrl: 'https://github.com/madarco/agentbox',
    });
    expect(boxInProject(b, rmt)).toBe(true);
  });

  it('does not match a different repo on a remote hub', () => {
    const b = box({ projectRoot: '/home/ci/other', originUrl: 'git@github.com:madarco/other.git' });
    expect(boxInProject(b, rmt)).toBe(false);
  });

  it('does not match when the box carries no origin and a foreign projectRoot', () => {
    const b = box({ projectRoot: '/home/ci/agentbox' });
    expect(boxInProject(b, rmt)).toBe(false);
  });
});

describe('isCrossMachineHub', () => {
  it('is false for a local hub', () => {
    expect(isCrossMachineHub({ mode: 'local', url: 'http://127.0.0.1:8787' })).toBe(false);
  });

  it('is false for our own `hub expose` (remote-mode over loopback)', () => {
    // Same machine → its boxes keep local projectRoots, so scope by folder.
    expect(isCrossMachineHub({ mode: 'remote', url: 'http://127.0.0.1:8787' })).toBe(false);
    expect(isCrossMachineHub({ mode: 'remote', url: 'http://localhost:8787' })).toBe(false);
  });

  it('is true for a configured remote control box', () => {
    expect(isCrossMachineHub({ mode: 'remote', url: 'https://hub.example.com' })).toBe(true);
    expect(isCrossMachineHub({ mode: 'remote', url: 'https://10.0.0.5:8787' })).toBe(true);
  });
});
