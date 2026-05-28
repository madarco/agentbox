// Pure state-matching helpers for `agentbox agent`. Extracted so they have a
// unit-testable surface — see test/agent-state.test.ts.

import type { BoxStatusClaude, ClaudeActivityState } from '@agentbox/ctl';

export const AGENT_WAIT_STATES = [
  'working',
  'idle',
  'waiting',
  'end-plan',
  'question',
  'prompt',
  'compacting',
  'error',
] as const;
export type AgentWaitState = (typeof AGENT_WAIT_STATES)[number];

export function isAgentWaitState(s: string): s is AgentWaitState {
  return (AGENT_WAIT_STATES as readonly string[]).includes(s);
}

/**
 * `prompt` means "ready for a new user message": Claude is idle, the tmux
 * session is up, and there's no pending plan or question payload. Used both
 * by `agent wait-for prompt` and as the human-readable label in `agent state`
 * when those conditions hold.
 */
export function isPromptReady(claude: BoxStatusClaude): boolean {
  return (
    claude.state === 'idle' &&
    claude.sessionRunning &&
    claude.plan === undefined &&
    claude.question === undefined
  );
}

export function matchesAgentWaitState(claude: BoxStatusClaude, target: AgentWaitState): boolean {
  if (target === 'prompt') return isPromptReady(claude);
  if (target === 'end-plan') {
    // ExitPlanMode triggers Notification:permission_prompt → state=waiting
    // almost immediately. The plan payload is what tells us the user is
    // parked at "approve the plan", so accept either signal.
    return claude.plan !== undefined || claude.state === 'end-plan';
  }
  if (target === 'question') {
    return claude.question !== undefined || claude.state === 'question';
  }
  return claude.state === (target as ClaudeActivityState);
}

/**
 * Display string used when no `--json` is requested. Prefers the semantic
 * label (`prompt` / `end-plan` / `question`) over the raw `waiting` flicker.
 */
export function derivedAgentState(claude: BoxStatusClaude): string {
  if (isPromptReady(claude)) return 'prompt';
  if (claude.plan !== undefined) return 'end-plan';
  if (claude.question !== undefined) return 'question';
  return claude.state;
}
