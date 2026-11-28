// The hub's default committer identity (`git.identity.name` / `.email`) for the
// boxes it builds with no PC behind them: a web-UI or tray create sends no
// identity, and the hub machine's own git config is nobody's. A CLI create
// sends the project's identity, which wins (see resolveCreateGitIdentity).
//
// Stored in THIS machine's global config, like `accounts.onLimit`.
import { homedir } from 'node:os';
import { loadEffectiveConfig, setConfigValue, unsetConfigValue } from '@agentbox/config';
import { parseGitIdentity, type GitIdentity } from '@agentbox/core';
import type { GitIdentityBackend, GitIdentityView } from '../boxes/backend-types';

/** The configured default, or undefined unless BOTH halves are set. */
export async function readHubGitIdentity(configHome = homedir()): Promise<GitIdentity | undefined> {
  const cfg = await loadEffectiveConfig(configHome).catch(() => null);
  const id = cfg?.effective.git?.identity;
  const parsed = parseGitIdentity({ name: id?.name, email: id?.email });
  return parsed.ok ? parsed.value : undefined;
}

export function createGitIdentityBackend(deps: { configHome?: string } = {}): GitIdentityBackend {
  const configHome = deps.configHome ?? homedir();
  const view = async (): Promise<GitIdentityView> => ({
    identity: (await readHubGitIdentity(configHome)) ?? null,
  });
  return {
    getHubGitIdentity: view,
    async setHubGitIdentity(input) {
      const body = (input ?? {}) as { identity?: unknown; ifUnset?: unknown };
      if (body.ifUnset !== undefined && typeof body.ifUnset !== 'boolean') {
        return { ok: false, code: 'invalid_request', error: 'ifUnset must be a boolean' };
      }
      if (body.identity === null) {
        if (body.ifUnset) {
          return { ok: false, code: 'invalid_request', error: 'ifUnset cannot clear the identity' };
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
    },
  };
}
