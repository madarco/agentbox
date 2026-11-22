// Shared plumbing for the /api/v1/skills routes: the custody store (reached
// through globalThis, like the custody routes, so @agentbox/relay stays out of
// Next's bundle) and the SkillsError → envelope mapping.
import { SkillsError, type SkillsStore } from '@/lib/backend/skills';
import { fail } from '../lib/envelope';

export function skillsStoreOrFail(): SkillsStore | Response {
  const custody = globalThis.__AGENTBOX_HUB_CUSTODY;
  if (!custody) return fail('backend_unavailable', 'custody is not enabled on this hub');
  return custody;
}

export function failFromSkills(err: unknown, fallback: string): Response {
  if (err instanceof SkillsError) return fail(err.code, err.message);
  const msg = err instanceof Error ? err.message : fallback;
  // Matched by name so the store's error class never has to be imported here.
  if (err instanceof Error && err.name === 'CustodyTooLargeError') {
    return fail(
      'invalid_request',
      `${msg}. Raise AGENTBOX_CUSTODY_MAX_BLOB_BYTES on this hub to store a bigger skill.`,
    );
  }
  if (err instanceof Error && err.name === 'CustodyPathError') return fail('invalid_request', msg);
  return fail('internal', msg);
}
