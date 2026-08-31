/**
 * Binds codex's login spec to its docker surface. Beside the runtime that is
 * its only caller — see `lib/agent-login-bindings.ts`.
 */
import {
  buildCodexLoginRunArgv,
  SHARED_CODEX_VOLUME,
  volumeHasCodexAuth,
} from '../docker-sync.js';
import { withLoginDefaults, type AgentLoginBinding } from '@agentbox/cli-kit';
import { CODEX_LOGIN_SPEC } from './login.js';

export function codexLoginBinding(o: {
  image: string;
  volume?: string;
  extraArgs?: string[];
}): AgentLoginBinding {
  const volume = o.volume ?? SHARED_CODEX_VOLUME;
  const { image } = o;
  const extraArgs = withLoginDefaults(CODEX_LOGIN_SPEC, o.extraArgs ?? []);
  return {
    spec: CODEX_LOGIN_SPEC,
    dockerArgv: buildCodexLoginRunArgv({ volume, image, extraArgs }),
    verify: () => volumeHasCodexAuth(volume, image),
  };
}
