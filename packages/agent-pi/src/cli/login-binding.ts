/**
 * Binds Pi's login spec to its docker surface. Beside the runtime that is its
 * only caller — see `cli-kit`'s `agent-login-bindings.ts`.
 */
import { withLoginDefaults, type AgentLoginBinding } from '@agentbox/cli-kit';
import { buildPiLoginRunArgv, SHARED_PI_VOLUME, volumeHasPiAuth } from '../docker-sync.js';
import { PI_LOGIN_SPEC } from './login.js';

export function piLoginBinding(o: {
  image: string;
  volume?: string;
  extraArgs?: string[];
}): AgentLoginBinding {
  const volume = o.volume ?? SHARED_PI_VOLUME;
  const { image } = o;
  const extraArgs = withLoginDefaults(PI_LOGIN_SPEC, o.extraArgs ?? []);
  return {
    spec: PI_LOGIN_SPEC,
    dockerArgv: buildPiLoginRunArgv({ volume, image, extraArgs }),
    verify: () => volumeHasPiAuth(volume, image),
  };
}
