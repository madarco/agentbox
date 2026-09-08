/**
 * Concern: the URL that opens a service agent's own UI, already signed in.
 *
 * A service agent (openclaw) generates its auth token INSIDE the box, and its
 * UI takes that token from the URL fragment. So the box's plain web URL is not
 * enough to reach the dashboard: it lands on a token prompt, and the value it
 * wants is in a file only the box can read.
 *
 * Lives here, in `sandbox-core`, rather than in the CLI because three surfaces
 * need the same answer -- `agentbox <agent> url`, the hub's REST API (and so
 * the web UI and the macOS tray through it), and any future client. Two
 * implementations of "where does the token go in the URL" would drift, and the
 * one that drifts silently produces a link that opens to a login prompt.
 *
 * The token is read AT CLICK TIME, never carried on the box list: reading it is
 * an exec into the box, and it is a live credential that has no business in
 * every poll of every box.
 */

import type { AgentServiceUrlField, BoxRecord, Provider } from '@agentbox/core';

/** One resolved url field: what it is called, its value, and where it belongs. */
export interface ServiceUrlFieldValue {
  label: string;
  value: string;
  /** Set when the value belongs in the URL fragment under this key. */
  fragmentKey?: string;
}

/** Walk a dotted path (`gateway.auth.token`) into a parsed JSON document. */
function atJsonPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Read an agent's declared url fields out of the running box.
 *
 * One read per distinct FILE, not per field: two fields out of one config would
 * otherwise be two exec round-trips into the box. A file that cannot be read is
 * not an error — a box that has not finished onboarding simply has no token
 * yet, and the caller falls back to the bare URL.
 */
export async function readServiceUrlFields(
  provider: Provider,
  box: BoxRecord,
  fields: readonly AgentServiceUrlField[],
): Promise<ServiceUrlFieldValue[]> {
  if (fields.length === 0) return [];
  const out: ServiceUrlFieldValue[] = [];
  const docs = new Map<string, unknown>();
  for (const field of fields) {
    if (!docs.has(field.file)) {
      let parsed: unknown;
      try {
        const r = await provider.exec(box, ['cat', field.file], { user: 'vscode' });
        parsed = r.exitCode === 0 ? JSON.parse(r.stdout) : undefined;
      } catch {
        parsed = undefined;
      }
      docs.set(field.file, parsed);
    }
    const value = atJsonPath(docs.get(field.file), field.jsonPath);
    if (typeof value === 'string' && value.length > 0) {
      out.push({
        label: field.label,
        value,
        ...(field.fragmentKey ? { fragmentKey: field.fragmentKey } : {}),
      });
    }
  }
  return out;
}

/**
 * The URL that opens the daemon's UI already signed in, or null when the agent
 * declares nothing that belongs in the URL.
 *
 * Null rather than the bare URL so a caller can tell "there is nothing to add"
 * from "here is a better link", and print or offer the second one only when it
 * actually says something the plain URL does not.
 */
export function serviceSignInUrl(
  url: string,
  fields: readonly ServiceUrlFieldValue[],
): string | null {
  const parts = fields
    .filter((f) => f.fragmentKey)
    .map((f) => `${encodeURIComponent(f.fragmentKey as string)}=${encodeURIComponent(f.value)}`);
  if (parts.length === 0) return null;
  // The UI is served from the root, and a fragment hung off a bare authority
  // (no path at all) is not something a browser opens predictably.
  const base = url.endsWith('/') ? url : `${url}/`;
  return `${base}#${parts.join('&')}`;
}
