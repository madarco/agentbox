import { describe, expect, it } from 'vitest';
import type { HubApiBox } from '../src/control-plane/hub-api-client.js';
import { boxInProject } from '../src/commands/list.js';

/** Minimal HubApiBox fixture — boxInProject only reads projectRoot + originUrl. */
function box(p: Partial<HubApiBox>): HubApiBox {
  return { id: 'b', name: 'b', task: 'b', provider: 'docker', status: 'running', branch: '', ...p };
}

const LAPTOP = '/Users/me/agentbox';
const ORIGIN = 'git@github.com:madarco/agentbox.git';

describe('boxInProject', () => {
  // `projectRootForeign` = the box's projectRoot names no directory on THIS
  // machine, so it must be a remote hub's own path (scope by origin). A local
  // folder — local hub or exposed loopback hub — is NOT foreign (scope by folder).
  const localFolder = { root: LAPTOP, origin: ORIGIN, projectRootForeign: false };
  const foreign = { root: LAPTOP, origin: ORIGIN, projectRootForeign: true };

  it('matches a box in the same folder', () => {
    // Exact folder match wins regardless of the foreign flag.
    expect(boxInProject(box({ projectRoot: LAPTOP }), localFolder)).toBe(true);
    expect(boxInProject(box({ projectRoot: LAPTOP }), foreign)).toBe(true);
  });

  it('keeps two same-origin folders that both exist locally apart', () => {
    // A box in a DIFFERENT local clone of the same repo (its folder exists here,
    // so it is not foreign) must not leak into this folder's scoped listing —
    // preserving the hub's folder-based project model. Covers both a local hub
    // and a same-machine `hub expose` (loopback), where the box IS local.
    const b = box({ projectRoot: '/Users/me/agentbox-2', originUrl: ORIGIN });
    expect(boxInProject(b, localFolder)).toBe(false);
  });

  it('scopes a registered box with no projectRoot by origin', () => {
    const b = box({ projectRoot: undefined, originUrl: ORIGIN });
    expect(boxInProject(b, localFolder)).toBe(true);
    expect(boxInProject(b, foreign)).toBe(true);
  });

  it('matches a remote hub box by origin when its projectRoot is foreign', () => {
    // On a hub on another machine the box carries the control box's absolute
    // projectRoot, which resolves to no local directory — so it must match on
    // repo identity, or project-scoped `ls` silently drops it. This holds however
    // the remote hub is reached (real hostname OR an SSH tunnel to loopback): the
    // signal is the non-resolving projectRoot, not the hub URL.
    const b = box({ projectRoot: '/home/ci/agentbox', originUrl: ORIGIN });
    expect(boxInProject(b, foreign)).toBe(true);
    // The same origin but a projectRoot that DOES exist locally stays folder-scoped.
    expect(boxInProject(b, localFolder)).toBe(false);
  });

  it('normalizes ssh vs https origins when matching', () => {
    const b = box({
      projectRoot: '/home/ci/agentbox',
      originUrl: 'https://github.com/madarco/agentbox',
    });
    expect(boxInProject(b, foreign)).toBe(true);
  });

  it('does not match a different repo on a remote hub', () => {
    const b = box({ projectRoot: '/home/ci/other', originUrl: 'git@github.com:madarco/other.git' });
    expect(boxInProject(b, foreign)).toBe(false);
  });

  it('does not match when the box carries no origin and a foreign projectRoot', () => {
    const b = box({ projectRoot: '/home/ci/agentbox' });
    expect(boxInProject(b, foreign)).toBe(false);
  });
});
