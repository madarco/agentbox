/**
 * Binds each agent's login spec to the docker surface it runs against: the
 * `docker run` argv, the post-exit credential check, and any post-success work.
 * Kept apart from `agent-login-specs.ts` (pure, unit-tested) and from
 * `agent-login-run.ts` (the pty loop) so neither has to know about volumes.
 */
import {
  buildClaudeLoginRunArgv,
  buildCodexLoginRunArgv,
  buildOpencodeLoginRunArgv,
  SHARED_CLAUDE_VOLUME,
  SHARED_CODEX_VOLUME,
  SHARED_OPENCODE_VOLUME,
  syncClaudeCredentials,
  volumeClaudeCredentials,
  volumeHasCodexAuth,
  volumeHasOpencodeAuth,
  warmUpClaudeCredentials,
} from '@agentbox/sandbox-docker';
import {
  CLAUDE_LOGIN_SPEC,
  CODEX_LOGIN_SPEC,
  OPENCODE_LOGIN_SPEC,
  type AgentLoginSpec,
} from './agent-login-specs.js';

export interface AgentLoginBinding {
  spec: AgentLoginSpec;
  dockerArgv: string[];
  /** True once the login actually wrote credentials into the volume. */
  verify: () => Promise<boolean>;
  /** Post-success work, e.g. claude's warm-up + host-backup sync. */
  finalize?: () => Promise<{ warmed?: boolean }>;
}

function withDefaults(spec: AgentLoginSpec, extraArgs: string[]): string[] {
  return extraArgs.length > 0 ? extraArgs : spec.defaultArgs;
}

export function claudeLoginBinding(o: {
  image: string;
  volume?: string;
  extraArgs?: string[];
  writeLog?: (line: string) => void;
}): AgentLoginBinding {
  const volume = o.volume ?? SHARED_CLAUDE_VOLUME;
  const { image } = o;
  const extraArgs = withDefaults(CLAUDE_LOGIN_SPEC, o.extraArgs ?? []);
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

export function codexLoginBinding(o: {
  image: string;
  volume?: string;
  extraArgs?: string[];
}): AgentLoginBinding {
  const volume = o.volume ?? SHARED_CODEX_VOLUME;
  const { image } = o;
  const extraArgs = withDefaults(CODEX_LOGIN_SPEC, o.extraArgs ?? []);
  return {
    spec: CODEX_LOGIN_SPEC,
    dockerArgv: buildCodexLoginRunArgv({ volume, image, extraArgs }),
    verify: () => volumeHasCodexAuth(volume, image),
  };
}

export function opencodeLoginBinding(o: {
  image: string;
  volume?: string;
  extraArgs?: string[];
}): AgentLoginBinding {
  const volume = o.volume ?? SHARED_OPENCODE_VOLUME;
  const { image } = o;
  const extraArgs = withDefaults(OPENCODE_LOGIN_SPEC, o.extraArgs ?? []);
  return {
    spec: OPENCODE_LOGIN_SPEC,
    dockerArgv: buildOpencodeLoginRunArgv({ volume, image, extraArgs }),
    verify: () => volumeHasOpencodeAuth(volume, image),
  };
}
