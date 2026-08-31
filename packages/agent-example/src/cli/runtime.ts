/**
 * The demo agent's CLI runtime — the smallest thing that satisfies
 * `AgentRuntime`.
 *
 * Read it as the answer to "what does an agent owe the CLI?". Every member here
 * is required by the contract; the optional ones (`resume`, `loginCommand`,
 * `requireCredsWhenNonTty`) are absent because this agent genuinely has no
 * resumable session and no login.
 */
import type { EffectiveConfig, UserConfig } from '@agentbox/config';
import type { AgentRuntime } from '@agentbox/cli-kit';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import {
  buildExampleAttachArgv,
  ensureExampleVolume,
  exampleSessionInfo,
  startExampleSession,
} from '../docker-sync.js';

const SPEC = resolveAgentSpec('example');

/** Thrown when the demo agent's tmux session is missing. */
export class ExampleSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExampleSessionError';
  }
}

export const exampleRuntime: AgentRuntime = {
  sharedVolume: SPEC.dockerVolume,
  SessionError: ExampleSessionError,

  startSession: (o) => startExampleSession(o.container),
  sessionInfo: (container) => exampleSessionInfo(container),
  buildAttachArgv: (container) => buildExampleAttachArgv(container),
  ensureVolume: (target, o) => ensureExampleVolume(target, { image: o.image }),

  // Its binary is a login shell, already in every box image — nothing to
  // install, and nothing to probe for on create.
  ensureInstalled: () => Promise.resolve(),
  ensureInstalledOnCreate: false,

  // No `BoxRecord` field and no `--isolate-example-config` flag: this agent
  // uses the shared volume, which is the honest default for one that stores no
  // credentials. An agent that needs isolation adds both.
  resolveConfigVolume: () => undefined,
  createBoxConfig: () => ({}),

  sessionNameOf: (cfg: EffectiveConfig) => cfg.example.sessionName,
  isolateOf: (cfg: EffectiveConfig) => cfg.box.isolateExampleConfig,
  cliOverrides: ({ sessionName }): Partial<UserConfig> => {
    const out: Partial<UserConfig> = {};
    if (sessionName !== undefined) out.example = { sessionName };
    return out;
  },

  // A shell has no permission prompts to skip.
  skipPermissions: null,

  // Nothing to sign in to: a login-shell agent has no credential at all, so
  // every login surface is a no-op rather than a stub that pretends.
  offerDockerLogin: () => Promise.resolve(),
  offerCloudLogin: () => Promise.resolve(),
  signIn: () => Promise.resolve({ ok: true as const }),
  loginBinding: () => {
    throw new ExampleSessionError('the example agent has no login');
  },
  // There is no login, so the value is inert; 'interactive-only' is the
  // narrower of the two and never triggers a headless path.
  loginNeedsTty: 'interactive-only',
  hostCredStatus: () => Promise.resolve({ status: 'ok' as const }),
};
