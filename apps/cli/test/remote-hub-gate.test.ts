import { describe, expect, it } from 'vitest';
import type { EffectiveConfig } from '@agentbox/config';
import {
  dockerProvidersHidden,
  isDockerProvider,
  dockerHiddenMessage,
  dockerHiddenReason,
  remoteHubConfigured,
} from '../src/control-plane/remote-hub.js';

/** Minimal effective config carrying only the fields the gate reads. */
function cfg(
  controlPlaneUrl: string | undefined,
  mode: 'auto' | 'thin' | 'local',
): EffectiveConfig {
  return {
    relay: { controlPlaneUrl },
    hub: { mode },
  } as unknown as EffectiveConfig;
}

describe('isDockerProvider', () => {
  it('covers docker and remote-docker (matching boxOwningHubIsLocal)', () => {
    expect(isDockerProvider('docker')).toBe(true);
    expect(isDockerProvider('remote-docker')).toBe(true);
    expect(isDockerProvider('e2b')).toBe(false);
    expect(isDockerProvider('hetzner')).toBe(false);
  });
});

describe('dockerProvidersHidden', () => {
  it('auto: hidden only when a control box is configured', () => {
    expect(dockerProvidersHidden(cfg(undefined, 'auto'))).toBe(false);
    expect(dockerProvidersHidden(cfg('https://cp.example', 'auto'))).toBe(true);
  });

  it('local: never hidden — the escape hatch, even under a control box', () => {
    expect(dockerProvidersHidden(cfg(undefined, 'local'))).toBe(false);
    expect(dockerProvidersHidden(cfg('https://cp.example', 'local'))).toBe(false);
  });

  it('thin: always hidden, even with no control box configured', () => {
    expect(dockerProvidersHidden(cfg(undefined, 'thin'))).toBe(true);
    expect(dockerProvidersHidden(cfg('https://cp.example', 'thin'))).toBe(true);
  });

  it('agrees with remoteHubConfigured under the default auto mode', () => {
    for (const url of [undefined, 'https://cp.example']) {
      const c = cfg(url, 'auto');
      expect(dockerProvidersHidden(c)).toBe(remoteHubConfigured(c));
    }
  });
});

describe('dockerHiddenReason', () => {
  it('distinguishes a control box from forced thin mode', () => {
    expect(dockerHiddenReason(cfg('https://cp.example', 'auto'))).toBe(
      'a control box is configured',
    );
    expect(dockerHiddenReason(cfg(undefined, 'thin'))).toBe('hub.mode is set to thin');
    // thin + a control box still reads as the control box (one IS configured).
    expect(dockerHiddenReason(cfg('https://cp.example', 'thin'))).toBe(
      'a control box is configured',
    );
  });
});

describe('dockerHiddenMessage', () => {
  it('names hub.mode=local and reflects the reason (control box vs thin)', () => {
    for (const context of ['create', 'prepare', 'setup'] as const) {
      const controlBox = dockerHiddenMessage(cfg('https://cp.example', 'auto'), context);
      expect(controlBox).toContain('hub.mode=local');
      expect(controlBox).toContain('a control box is configured');
      const thin = dockerHiddenMessage(cfg(undefined, 'thin'), context);
      expect(thin).toContain('hub.mode=local');
      expect(thin).toContain('hub.mode is set to thin');
    }
  });
});
