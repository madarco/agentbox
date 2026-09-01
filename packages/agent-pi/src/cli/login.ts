/**
 * Pi's guided-login detector — see `@agentbox/cli-kit`'s `agent-login-specs.ts`
 * for what a detector is and why the flow is driven from the host.
 *
 * Pi has **no non-interactive login**: signing in is the in-TUI `/login` slash
 * command, which opens a provider picker inside a full-screen TUI. There is no
 * prompt sequence a host can drive keystroke-by-keystroke, so `detect` returns
 * null unconditionally and every login falls through to the passthrough that
 * hands Pi the user's terminal.
 *
 * This is a real "no", not a stub: reporting a prompt we cannot actually answer
 * would strand the user in a guided flow that never completes.
 */

import type { AgentLoginSpec } from '@agentbox/cli-kit';

export const PI_LOGIN_SPEC: AgentLoginSpec = {
  agent: 'pi',
  defaultArgs: [],
  detect: () => null,
};
