/**
 * Per-agent knowledge for the guided login flow: given the output an agent's
 * `login` command has printed so far, say what it is waiting for. Pure — no pty,
 * no docker — so the detectors are unit-tested against real captured transcripts
 * (see `docs/agent-login-guided-plan.md` for the captures these encode).
 *
 * The guided flow exists because handing the user's terminal to an agent's own
 * in-container TUI breaks on terminals we haven't validated (kitty's CSI-u
 * keyboard protocol). Instead we drive the container under a pty and reproduce
 * the interaction with our own host-side clack prompts — which means we have to
 * recognize each prompt from its rendered output.
 */

export type AgentName = 'claude' | 'codex' | 'opencode';

/** What the login container is currently waiting for. */
export type LoginNeed =
  /** Approve in a browser, then paste the code back (claude). */
  | { kind: 'paste-code'; url: string }
  /** Approve in a browser; the flow completes on its own (codex device auth). */
  | { kind: 'browser-only'; url: string; userCode?: string }
  /** A secret typed at a prompt — never echoed, never logged (opencode API key). */
  | { kind: 'secret'; label: string; hint?: string }
  /** A prompt shape we can't drive from the host; the caller falls back to the passthrough. */
  | { kind: 'unsupported'; reason: string };

export interface AgentLoginSpec {
  agent: AgentName;
  /** Login args used when the caller forwards none. */
  defaultArgs: string[];
  /** What the container is waiting for, or null while it's still working. */
  detect(buf: string): LoginNeed | null;
  /**
   * After input is submitted, output matching this means the agent rejected it
   * and re-prompted (rather than exiting), so the caller can ask again against
   * the same still-valid session.
   */
  invalidInputPattern?: RegExp;
}

// Strip CSI (color/cursor) escapes only. OSC hyperlinks (OSC 8) embed the URL
// itself, so leaving them in lets a URL regex still match inside them. Built via
// RegExp(string) so the ESC byte and the `/` intermediate stay unambiguous.
const CSI = new RegExp('\\u001b\\[[0-9;?]*[ -\\/]*[@-~]', 'g');

export function stripAnsi(text: string): string {
  return text.replace(CSI, '');
}

/** Trim the punctuation/brackets a URL regex greedily swallows from prose. */
function trimUrl(url: string): string {
  return url.replace(/["'`)\]>]+$/, '').replace(/[.,;]+$/, '');
}

// The char class excludes whitespace, quotes/brackets, and control bytes (so an
// OSC-8 hyperlink's trailing BEL terminates the match cleanly).
const URL_BODY = "[^\\s'\"`<>)\\]\\u0000-\\u001f]";

// ---------------------------------------------------------------- claude

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

const INVALID_CODE = /invalid|incorrect|not a valid|try again|expired|rejected/i;

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

// ---------------------------------------------------------------- codex

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

// ---------------------------------------------------------------- opencode

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

export const LOGIN_SPECS: Record<AgentName, AgentLoginSpec> = {
  claude: CLAUDE_LOGIN_SPEC,
  codex: CODEX_LOGIN_SPEC,
  opencode: OPENCODE_LOGIN_SPEC,
};
