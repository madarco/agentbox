import { join } from 'node:path';
import { STATE_DIR } from '@agentbox/config';
import { ShareError, fileShareStore, type ShareStore } from '@/lib/backend/usage-share';
import { fail } from '../../lib/envelope';

/**
 * The shares this hub made, with their delete secrets (0600). One per process: each
 * route may be bundled with its own copy of this module, and the store serializes
 * its read-modify-write only within one instance.
 */
export const shareStore: ShareStore = (globalThis.__AGENTBOX_HUB_SHARE_STORE ??= fileShareStore(
  join(STATE_DIR, 'hub', 'share.json'),
));

export function failShare(e: unknown): Response {
  if (e instanceof ShareError) {
    if (e.retryAfter === undefined) return fail(e.code, e.message);
    const res = fail(e.code, e.message, { retryAfter: e.retryAfter });
    res.headers.set('Retry-After', String(e.retryAfter));
    return res;
  }
  return fail('internal', `usage share failed: ${e instanceof Error ? e.message : String(e)}`);
}
