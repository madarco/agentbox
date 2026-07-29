import { describe, expect, it } from 'vitest';
import { resolvePrepareTargetKind } from '../src/commands/prepare.js';

// Pure "which hub does this bake target" decision. Guards the fallbacks whose
// loss (when the inline `resolvePrepareRouting` was deleted) regressed the
// cloud.viaHub and remote-docker cases. `local: true` means this machine's hub;
// `false` means the remote control box. Never an inline bake either way.
describe('resolvePrepareTargetKind', () => {
  const remote = { controlPlaneUrl: 'https://cp.example', viaHub: true, coLocated: false };

  it('targets local when the hub is already co-located', () => {
    expect(
      resolvePrepareTargetKind({ ...remote, coLocated: true, providerName: 'e2b' }).local,
    ).toBe(true);
  });

  it('targets local when no control box is configured', () => {
    expect(
      resolvePrepareTargetKind({
        coLocated: false,
        controlPlaneUrl: undefined,
        viaHub: true,
        providerName: 'e2b',
      }).local,
    ).toBe(true);
  });

  it('targets the control box for a cloud provider by default', () => {
    expect(resolvePrepareTargetKind({ ...remote, providerName: 'e2b' })).toEqual({ local: false });
  });

  it('honors cloud.viaHub=false — the config key survives the flag removal', () => {
    const r = resolvePrepareTargetKind({ ...remote, viaHub: false, providerName: 'e2b' });
    expect(r.local).toBe(true);
    expect(r.reason).toMatch(/viaHub/);
  });

  it('keeps a docker base local even with a control box (its image is on this machine)', () => {
    expect(resolvePrepareTargetKind({ ...remote, providerName: 'docker' }).local).toBe(true);
  });

  it('falls back to local when the control box does not know a remote-docker alias', () => {
    const r = resolvePrepareTargetKind({
      ...remote,
      providerName: 'remote-docker',
      remoteHost: 'buildbox',
      controlBoxKnowsHost: false,
    });
    expect(r.local).toBe(true);
    expect(r.reason).toMatch(/buildbox/);
  });

  it('bakes a remote-docker host on the control box when it knows the alias', () => {
    expect(
      resolvePrepareTargetKind({
        ...remote,
        providerName: 'remote-docker',
        remoteHost: 'buildbox',
        controlBoxKnowsHost: true,
      }).local,
    ).toBe(false);
  });
});
