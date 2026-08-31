/**
 * Binds claude's login spec to the docker surface it runs against: the
 * `docker run` argv, the post-exit credential check, and the post-success
 * warm-up. Beside the runtime that is its only caller — see
 * `lib/agent-login-bindings.ts` for why it is not in the shared lib.
 */
import { syncClaudeCredentials, volumeClaudeCredentials } from '@agentbox/sandbox-docker';
import {
  buildClaudeLoginRunArgv,
  SHARED_CLAUDE_VOLUME,
  warmUpClaudeCredentials,
} from '../docker-sync.js';
import { withLoginDefaults, type AgentLoginBinding } from '@agentbox/cli-kit';
import { CLAUDE_LOGIN_SPEC } from './login.js';

export function claudeLoginBinding(o: {
  image: string;
  volume?: string;
  extraArgs?: string[];
  writeLog?: (line: string) => void;
}): AgentLoginBinding {
  const volume = o.volume ?? SHARED_CLAUDE_VOLUME;
  const { image } = o;
  const extraArgs = withLoginDefaults(CLAUDE_LOGIN_SPEC, o.extraArgs ?? []);
  return {
    spec: CLAUDE_LOGIN_SPEC,
    dockerArgv: buildClaudeLoginRunArgv({ volume, image, extraArgs }),
    verify: async () => (await volumeClaudeCredentials(volume, image)).hasRefreshToken,
    // Absorb the fresh-token first-request 400 in a throwaway container before
    // any box uses these credentials, then mirror them to the host backup.
    finalize: async () => {
      const warm = await warmUpClaudeCredentials(volume, image, {
        onProgress: (l) => o.writeLog?.(l),
      });
      await syncClaudeCredentials({ volume }, { image, isolate: false });
      return { warmed: warm.warmed };
    },
  };
}
