/**
 * Codex's guided-login detector — see `../../lib/agent-login-specs.ts` for what
 * a detector is and why the flow is driven from the host.
 */

import { stripAnsi, trimUrl, URL_BODY, type AgentLoginSpec } from '../../lib/agent-login-specs.js';

// `codex login --device-auth` prints a verification link and a one-time code,
// then polls until the browser completes — nothing is ever typed.
const CODEX_DEVICE_URL = new RegExp(`https?://${URL_BODY}*openai\\.com/${URL_BODY}*device${URL_BODY}*`, 'i');
// e.g. `YQ16-PPHIE` — two uppercase alphanumeric groups, alone on its line.
const CODEX_USER_CODE = /^\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\s*$/m;

export function extractCodexUserCode(text: string): string | null {
  const m = stripAnsi(text).match(CODEX_USER_CODE);
  return m?.[1] ?? null;
}

export const CODEX_LOGIN_SPEC: AgentLoginSpec = {
  agent: 'codex',
  defaultArgs: ['--device-auth'],
  detect(buf) {
    const clean = stripAnsi(buf);
    const m = clean.match(CODEX_DEVICE_URL);
    if (!m) return null;
    const url = trimUrl(m[0]);
    const userCode = extractCodexUserCode(clean);
    // The code prints right under the URL; wait for it rather than showing a
    // link the user can't complete. The core's URL timeout bounds the wait.
    if (!userCode) return null;
    return { kind: 'browser-only', url, userCode };
  },
};
