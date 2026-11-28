// The hub's default committer identity (`git.identity.name` / `.email`) for the
// boxes it builds with no PC behind them: a web-UI or tray create sends no
// identity, and the hub machine's own git config is nobody's. A CLI create
// sends the project's identity, which wins (see resolveCreateGitIdentity).
//
// Stored in THIS machine's global config, like `accounts.onLimit`.
import { homedir } from 'node:os';
import { loadEffectiveConfig, setConfigValue, unsetConfigValue } from '@agentbox/config';
import {
  parseGitIdentity,
  resolveCreateGitIdentity,
  type GitIdentity,
  type ResolvedGitIdentity,
} from '@agentbox/core';
import type { GitIdentityBackend, GitIdentityView } from '../boxes/backend-types';

/**
 * The configured default, or undefined unless BOTH halves are set. `cwd` is
 * only where config resolution starts; the global file is `~/.agentbox`.
 */
export async function readHubGitIdentity(cwd = homedir()): Promise<GitIdentity | undefined> {
  const cfg = await loadEffectiveConfig(cwd).catch(() => null);
  const id = cfg?.effective.git?.identity;
  const parsed = parseGitIdentity({ name: id?.name, email: id?.email });
  return parsed.ok ? parsed.value : undefined;
}

/**
 * The identity a hub-built box commits as, on every hub create path (the
 * worker's clones and folders on this machine alike): the requester's, else
 * this hub's default. Undefined leaves the provider to the building folder's
 * effective git config and then the generic fallback.
 */
export async function createGitIdentity(
  requested: GitIdentity | undefined,
  readDefault: () => Promise<GitIdentity | undefined> = () => readHubGitIdentity(),
): Promise<ResolvedGitIdentity | undefined> {
  return resolveCreateGitIdentity(requested, requested ? undefined : await readDefault());
}

// Writes are two config keys plus an `ifUnset` check: serialized so two PCs
// enrolling at once cannot leave one's name beside the other's email.
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

export function createGitIdentityBackend(deps: { cwd?: string } = {}): GitIdentityBackend {
  const configHome = deps.cwd ?? homedir();
  const view = async (): Promise<GitIdentityView> => ({
    identity: (await readHubGitIdentity(configHome)) ?? null,
  });
  return {
    getHubGitIdentity: view,
    setHubGitIdentity: (input) =>
      serialized(async () => {
        const body = (input ?? {}) as { identity?: unknown; ifUnset?: unknown };
        if (body.ifUnset !== undefined && typeof body.ifUnset !== 'boolean') {
          return { ok: false, code: 'invalid_request', error: 'ifUnset must be a boolean' };
        }
        if (body.identity === null) {
          if (body.ifUnset) {
            return {
              ok: false,
              code: 'invalid_request',
              error: 'ifUnset cannot clear the identity',
            };
          }
          await unsetConfigValue('global', 'git.identity.name', configHome);
          await unsetConfigValue('global', 'git.identity.email', configHome);
          return { ok: true, value: await view() };
        }
        const parsed = parseGitIdentity(body.identity, 'identity');
        if (!parsed.ok) return { ok: false, code: 'invalid_request', error: parsed.error };
        // `ifUnset`: a PC enrolling offers its identity, and must never replace
        // one somebody already chose. The answer says which one is in force.
        if (body.ifUnset && (await readHubGitIdentity(configHome))) {
          return { ok: true, value: { ...(await view()), unchanged: true } };
        }
        await setConfigValue('global', 'git.identity.name', parsed.value.name, configHome);
        await setConfigValue('global', 'git.identity.email', parsed.value.email, configHome);
        return { ok: true, value: await view() };
      }),
  };
}
