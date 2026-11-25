// Who may read a library skill's CONTENT (the diff, SKILL.md, the tarball).
// Custody's elevated byte read (admin token, an enrolled device's token, or
// loopback on a token hub) — plus a signed-in owner session. A skill is
// instructions the owner wrote or chose, not a credential: the person logged in
// to the hub's web UI may read it, so the update diff and the SKILL.md editor
// work on a password hub. Custody itself keeps the stricter rule
// (`custodyByteReadAuthorized`): it holds SSH private keys and agent logins.
// The plain API key still never reads skill content.
import { custodyByteReadAuthorized } from './custody-auth';
import type { RequestActor } from './request-actor';

export function skillContentReadAuthorized(
  args: Parameters<typeof custodyByteReadAuthorized>[0] & { actor: RequestActor },
): boolean {
  if (args.actor.kind === 'session') return true;
  return custodyByteReadAuthorized(args);
}

/**
 * Who may compare, pull or send skills with a machine (`/api/v1/skill-machines`).
 * Stricter than reading content: these act ON a PC (read its skill dirs, write
 * into `~/.agents/skills`), and the hub's own machine runs them with no confirm.
 * So only the owner — a signed-in session, the admin token, or loopback on a
 * token hub. An enrolled device's own token is refused: it identifies one PC,
 * not the owner, and must not act on the owner's machine or the library.
 */
export function skillMachineActAuthorized(
  args: Parameters<typeof custodyByteReadAuthorized>[0] & { actor: RequestActor },
): boolean {
  if (args.actor.kind === 'session') return true;
  return custodyByteReadAuthorized({ ...args, providedTokenIsDevice: false });
}
