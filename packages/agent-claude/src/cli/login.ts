/**
 * Claude Code's guided-login detector — see `../../lib/agent-login-specs.ts` for what
 * a detector is and why the flow is driven from the host.
 */

import {
  stripAnsi,
  trimUrl,
  URL_BODY,
  INVALID_CODE,
  type AgentLoginSpec,
} from '@agentbox/cli-kit';

// Match an OAuth approval URL on any current Claude/Anthropic auth host
// (claude.com/cai/oauth/…, claude.ai, console.anthropic.com) and REQUIRE the
// literal `oauth` in the path/query so an unrelated claude.com link can't match.
const CLAUDE_OAUTH_URL = new RegExp(
  `https?://(?:claude\\.com|claude\\.ai|console\\.anthropic\\.com)/${URL_BODY}*oauth${URL_BODY}*`,
  'i',
);

/**
 * Pull the OAuth approval URL out of accumulated (possibly ANSI-styled) login
 * output. Claude's paste-code flow prints a `https://claude.com/cai/oauth/…`
 * (or claude.ai / console.anthropic.com) link.
 */
export function extractOAuthUrl(text: string): string | null {
  const m = stripAnsi(text).match(CLAUDE_OAUTH_URL);
  return m ? trimUrl(m[0]) : null;
}

export const CLAUDE_LOGIN_SPEC: AgentLoginSpec = {
  agent: 'claude',
  // No method flags → the subscription paste-code flow (prints a URL, reads a code).
  defaultArgs: ['--claudeai'],
  detect(buf) {
    const url = extractOAuthUrl(buf);
    return url ? { kind: 'paste-code', url } : null;
  },
  invalidInputPattern: INVALID_CODE,
};
