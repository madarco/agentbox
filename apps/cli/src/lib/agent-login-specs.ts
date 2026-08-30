/**
 * Per-agent knowledge for the guided login flow: given the output an agent's
 * `login` command has printed so far, say what it is waiting for. Pure — no pty,
 * no docker — so the detectors are unit-tested against real captured transcripts
 * (each entry encodes a real capture of that agent's login flow).
 *
 * The guided flow exists because handing the user's terminal to an agent's own
 * in-container TUI breaks on terminals we haven't validated (kitty's CSI-u
 * keyboard protocol). Instead we drive the container under a pty and reproduce
 * the interaction with our own host-side clack prompts — which means we have to
 * recognize each prompt from its rendered output.
 */
import type { AgentId } from '@agentbox/core';

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
  agent: AgentId;
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
export function trimUrl(url: string): string {
  return url.replace(/["'`)\]>]+$/, '').replace(/[.,;]+$/, '');
}

// The char class excludes whitespace, quotes/brackets, and control bytes (so an
// OSC-8 hyperlink's trailing BEL terminates the match cleanly).
export const URL_BODY = "[^\\s'\"`<>)\\]\\u0000-\\u001f]";

/** Output meaning "that input was wrong, try again" — claude and opencode both re-prompt. */
export const INVALID_CODE = /invalid|incorrect|not a valid|try again|expired|rejected/i;
