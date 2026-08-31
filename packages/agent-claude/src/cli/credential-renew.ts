/**
 * Actively renew claude's saved host login.
 *
 * Moved out of `sandbox-docker/src/credential-refresh.ts`. Living there meant it
 * had to reach claude's own warm-up through `requireAgentSyncModule('claude')` —
 * an inversion that existed only because the code was on the wrong side of the
 * boundary. Here it calls `warmUpClaudeCredentials` directly, and the registry
 * lookup is gone.
 *
 * The generic `dockerCredentialRefresh` stays in `sandbox-docker`: that one is
 * the provider-neutral refresher hook, not claude's behaviour.
 */

import { DEFAULT_BOX_IMAGE, syncClaudeCredentials } from '@agentbox/sandbox-docker';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { warmUpClaudeCredentials } from '../docker-sync.js';

/** Outcome of {@link renewClaudeCredential}. */
export type RenewClaudeResult = 'renewed' | 'unchanged' | 'failed';

/**
 * Renew the saved claude login through the shared docker volume, and report
 * whether it still works.
 *
 * A credential's health is not readable off disk: `expiresAt` only dates the
 * ~8h access token, and a refresh token that was rotated away by another copy
 * looks perfectly valid until you try it. The only honest test is to use it —
 * so drive the same pair the successful-login path runs in its `finalize`:
 *
 *  1. `syncClaudeCredentials` — converge volume and backup on the newer blob,
 *     so we renew from the freshest copy rather than whichever the volume holds.
 *  2. `warmUpClaudeCredentials` — a headless `claude -p` forces a real OAuth
 *     refresh, minting a fresh access token into the volume.
 *  3. `syncClaudeCredentials` again — extract that fresh blob to the host backup
 *     so the cloud seed (and every later box) gets a live credential.
 *
 * This is what keeps the fleet logged in without nagging: a lapsed access token
 * is renewed silently, and only a genuine failure — `'failed'` — is worth
 * asking the user to sign in again for.
 *
 * `attempts` is deliberately small (2 by default): the login path's 6 exist to
 * outwait the fresh-token first-request 400, but on the create path every extra
 * attempt costs the user 5s + a container start before we can say "dead".
 *
 * Best-effort: any docker failure resolves to `'failed'`, never throws.
 */
export async function renewClaudeCredential(opts: {
  image?: string;
  attempts?: number;
  onLog?: (msg: string) => void;
}): Promise<RenewClaudeResult> {
  const log = opts.onLog ?? (() => {});
  const image = opts.image ?? DEFAULT_BOX_IMAGE;
  const volume = resolveAgentSpec('claude').dockerVolume;
  try {
    await syncClaudeCredentials({ volume }, { image, isolate: false });
    const warm = await warmUpClaudeCredentials(volume, image, {
      attempts: opts.attempts ?? 2,
      onProgress: (line: string) => {
        log(line);
      },
    });
    if (!warm.warmed) {
      log('claude: saved login did not renew — it may have been rotated away by another box');
      return 'failed';
    }
    const synced = await syncClaudeCredentials({ volume }, { image, isolate: false });
    return synced.direction === 'extracted' ? 'renewed' : 'unchanged';
  } catch {
    return 'failed';
  }
}
