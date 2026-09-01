import { describe, expect, it } from 'vitest';
import { variantImageRef } from '@agentbox/sandbox-docker';
import { resolveClaudeCredHealth } from '../src/cli/cred-health.js';

/**
 * The renewal probe RUNS `claude -p`. Since one-agent-per-box the base image is
 * agentless, and every caller hands this function a BASE ref (`box.image`,
 * `DEFAULT_BOX_IMAGE`) — so probing with it verbatim made renewal fail on a
 * perfectly live credential and report `dead`, nagging the user to sign in
 * again. It must probe claude's derived variant instead.
 */
const BASE = 'agentbox/box:dev';
const VARIANT = variantImageRef(BASE, ['claude']);

function probes(over: Partial<Parameters<typeof resolveClaudeCredHealth>[0]['probes']> = {}) {
  return {
    hostBackupHasCredentials: async () => true,
    loginDead: async () => false,
    accessTokenExpired: async () => true, // force the renewal branch
    imageExists: async () => true,
    renew: async () => 'renewed' as const,
    ...over,
  };
}

describe('resolveClaudeCredHealth probes the claude variant, not the agentless base', () => {
  it('derives the variant ref — it is not the base', () => {
    expect(VARIANT).not.toBe(BASE);
  });

  it('renews in the variant image', async () => {
    const seen: string[] = [];
    const health = await resolveClaudeCredHealth({
      image: BASE,
      probes: probes({
        renew: async (o: { image: string }) => {
          seen.push(o.image);
          return 'renewed' as const;
        },
      }),
    });
    expect(health).toBe('ok');
    expect(seen).toEqual([VARIANT]);
  });

  it('gates the existence check on the variant too, so no probe implies no build', async () => {
    const asked: string[] = [];
    let renewed = false;
    const health = await resolveClaudeCredHealth({
      image: BASE,
      probes: probes({
        imageExists: async (img: string) => {
          asked.push(img);
          return false; // the variant is not built here
        },
        renew: async () => {
          renewed = true;
          return 'failed' as const;
        },
      }),
    });
    expect(asked).toEqual([VARIANT]);
    // Never renews, and never reports dead over a credential it could not test.
    expect(renewed).toBe(false);
    expect(health).toBe('ok');
  });
});
