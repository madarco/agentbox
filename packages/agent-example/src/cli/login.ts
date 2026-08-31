import type { AgentLoginSpec } from '@agentbox/cli-kit';

/**
 * A login spec for an agent with no login.
 *
 * `AgentModule` requires one, and this is the honest shape: the detector never
 * reports a need, because nothing a login shell prints is an auth prompt. An
 * agent that genuinely signs in fills `detect` in — see
 * `@agentbox/agent-codex/cli`'s, which matches a device-code URL.
 */
export const EXAMPLE_LOGIN_SPEC: AgentLoginSpec = {
  agent: 'example',
  defaultArgs: [],
  detect: () => null,
};
