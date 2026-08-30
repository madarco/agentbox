/**
 * OpenCode's guided-login detector — see `../../lib/agent-login-specs.ts` for what
 * a detector is and why the flow is driven from the host.
 */

import { stripAnsi, trimUrl, URL_BODY, INVALID_CODE, type AgentLoginSpec } from '../../lib/agent-login-specs.js';

// `opencode auth login` is a per-provider prompt TREE (clack), not one prompt:
// most providers ask for an API key, `opencode` prefixes a "create a key at
// <url>" note, and github-copilot opens a nested select. We drive the shapes we
// can recognize and hand the rest back to the passthrough.
const OPENCODE_API_KEY = /Enter your API key/i;
const OPENCODE_KEY_HINT = new RegExp(`Create an api key at\\s+(https?://${URL_BODY}*)`, 'i');
// The clack prompt symbol keeps this off prose that merely says "select".
const OPENCODE_SELECT = /[◆◇]\s+Select\s+([^\n]+)/i;
const OPENCODE_UNKNOWN_PROVIDER = /Unknown provider\s+"([^"]*)"/i;
const OPENCODE_OAUTH_URL = new RegExp(`https?://${URL_BODY}*(?:oauth|device|authorize)${URL_BODY}*`, 'i');

export const OPENCODE_LOGIN_SPEC: AgentLoginSpec = {
  agent: 'opencode',
  defaultArgs: [],
  detect(buf) {
    const clean = stripAnsi(buf);

    const unknown = clean.match(OPENCODE_UNKNOWN_PROVIDER);
    if (unknown) return { kind: 'unsupported', reason: `unknown provider "${unknown[1] ?? ''}"` };

    if (OPENCODE_API_KEY.test(clean)) {
      const hint = clean.match(OPENCODE_KEY_HINT)?.[1];
      return hint
        ? { kind: 'secret', label: 'API key', hint: trimUrl(hint) }
        : { kind: 'secret', label: 'API key' };
    }

    const oauth = clean.match(OPENCODE_OAUTH_URL);
    if (oauth) return { kind: 'paste-code', url: trimUrl(oauth[0]) };

    // A select we didn't skip with `--provider` / `--method` (e.g.
    // github-copilot's deployment-type picker). Can't be driven from the host.
    const select = clean.match(OPENCODE_SELECT)?.[1];
    if (select) return { kind: 'unsupported', reason: `it asks to Select ${select.trim()}` };

    return null;
  },
  invalidInputPattern: INVALID_CODE,
};
