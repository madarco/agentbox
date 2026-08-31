/**
 * Binds opencode's login spec to its docker surface. Beside the runtime that is
 * its only caller — see `lib/agent-login-bindings.ts`.
 */
import {
  buildOpencodeLoginRunArgv,
  SHARED_OPENCODE_VOLUME,
  volumeHasOpencodeAuth,
} from '@agentbox/agent-opencode';
import { withLoginDefaults, type AgentLoginBinding } from '../../lib/agent-login-bindings.js';
import { OPENCODE_LOGIN_SPEC } from './login.js';

export function opencodeLoginBinding(o: {
  image: string;
  volume?: string;
  extraArgs?: string[];
}): AgentLoginBinding {
  const volume = o.volume ?? SHARED_OPENCODE_VOLUME;
  const { image } = o;
  const extraArgs = withLoginDefaults(OPENCODE_LOGIN_SPEC, o.extraArgs ?? []);
  return {
    spec: OPENCODE_LOGIN_SPEC,
    dockerArgv: buildOpencodeLoginRunArgv({ volume, image, extraArgs }),
    verify: () => volumeHasOpencodeAuth(volume, image),
  };
}
