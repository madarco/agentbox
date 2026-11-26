// A docker box's OWN credential file (docs/hot-switch-subscriptions-plan.md).
//
// An agent's config volume belongs to an account and is shared by every box on
// it, so a login written there moves all of them. Each box instead gets a host
// file bind-mounted over the agent's `credential.boxAbsPath`. Switching the box
// to another login is a write to that file, and the fan-out writes it for the
// boxes on the account.
//
// Writes go IN PLACE. A file bind pins the inode, so a tmp + rename on the host
// would leave the container reading the old file. Inside the box, claude's own
// rename onto the mount fails with EBUSY and it falls back to writing in place
// (measured), so its refreshes land here too, never in the volume.
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { boxRunDirFor, type BoxDirRef } from './sync/host-export.js';

/** Host path of `agent`'s per-box credential file. Throws for an agent without a credential. */
export function boxCredentialFile(box: BoxDirRef, agent: string): string {
  const cred = resolveAgentSpec(agent).credential;
  if (!cred) throw new Error(`agent '${agent}' declares no credential`);
  return join(boxRunDirFor(box), 'credentials', agent, basename(cred.boxRelPath));
}

/** `-v` spec mounting the per-box file over the agent's in-box credential path. */
export function boxCredentialMount(box: BoxDirRef, agent: string): string {
  const cred = resolveAgentSpec(agent).credential;
  if (!cred) throw new Error(`agent '${agent}' declares no credential`);
  return `${boxCredentialFile(box, agent)}:${cred.boxAbsPath}`;
}

/** Write `content` into the box's own credential file, in place. Returns its path. */
export async function writeBoxCredentialFile(
  box: BoxDirRef,
  agent: string,
  content: string,
): Promise<string> {
  const file = boxCredentialFile(box, agent);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // `w` truncates the existing inode rather than replacing it.
  await writeFile(file, content, { mode: 0o600, flag: 'w' });
  return file;
}

/**
 * What a per-box file starts as when the account's volume holds no login (a
 * box on a setup token or API key). Claude reads `{}` as plainly logged out and
 * leaves it alone (measured), so the env token still wins and a later switch to
 * a login can write the file. Another shape has no known-safe empty value, so
 * that agent gets no per-box file and keeps the volume's.
 */
export function emptyCredentialPlaceholder(agent: string): string | null {
  return resolveAgentSpec(agent).credential?.realShape === 'claude-oauth' ? '{}\n' : null;
}
