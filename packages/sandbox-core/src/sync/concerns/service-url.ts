/**
 * Concern: the URL that opens a service agent's own UI, already signed in.
 *
 * A service agent (openclaw) generates its auth token INSIDE the box, and its
 * UI takes that token from the URL fragment. So the box's plain web URL is not
 * enough to reach the dashboard: it lands on a token prompt, and the value it
 * wants is in a file only the box can read.
 *
 * The value is read through the daemon's OWN command where it has one
 * (`openclaw dashboard --json --no-open`) rather than out of its config file:
 * that is the interface it supports, so it survives a config-layout change, and
 * it means AgentBox never has to know how a third-party daemon stores its
 * secrets.
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

import type { AgentServiceUrlField, AgentSyncSpec, BoxRecord, Provider } from '@agentbox/core';
import { findAgentSpec } from '../registry.js';

/**
 * The SERVICE agent a box hosts, if any — the daemon whose UI has a token.
 *
 * Scans every agent the box knows about rather than trusting `lastAgent`, which
 * is "whichever agent ran most recently" and is overwritten by a later
 * `agentbox claude` in the same box. The gateway is still running there; reading
 * only `lastAgent` would decide the box has no UI to sign in to and hand the
 * user a token prompt.
 */
export function serviceAgentForBox(
  box: Pick<BoxRecord, 'lastAgent' | 'agents'>,
): AgentSyncSpec | undefined {
  const ids = [box.lastAgent, ...(box.agents ?? [])].filter((v): v is string => !!v);
  for (const id of ids) {
    const spec = findAgentSpec(id);
    if (spec?.caps.surface === 'service') return spec;
  }
  return undefined;
}

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

/** The argv that produces one field's JSON, and a cache key for it. */
function sourceArgv(field: AgentServiceUrlField): string[] | null {
  if (field.command && field.command.length > 0) return [...field.command];
  if (field.file) return ['cat', field.file];
  return null;
}

/** Lift `token` out of `http://127.0.0.1:18789/#token=abc&x=y`. */
function fragmentParam(raw: string, key: string): string | undefined {
  const hash = raw.indexOf('#');
  if (hash < 0) return undefined;
  const params = new URLSearchParams(raw.slice(hash + 1));
  return params.get(key) ?? undefined;
}

/**
 * Read an agent's declared url fields out of the running box.
 *
 * One read per distinct SOURCE, not per field: two fields out of one config (or
 * one command) would otherwise be two round-trips into the box. A source that
 * fails is not an error — a box whose daemon has not finished onboarding simply
 * has no token yet, and the caller falls back to the bare URL rather than
 * refusing to open anything.
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
    const argv = sourceArgv(field);
    if (!argv) continue;
    const key = argv.join('\u0000');
    if (!docs.has(key)) {
      let parsed: unknown;
      try {
        const r = await provider.exec(box, argv, { user: 'vscode' });
        // A daemon's CLI may print a banner before its JSON, so parse from the
        // first `{` rather than requiring the whole of stdout to be the payload.
        const body = r.stdout.slice(r.stdout.indexOf('{'));
        parsed = r.exitCode === 0 && body.startsWith('{') ? JSON.parse(body) : undefined;
      } catch {
        parsed = undefined;
      }
      docs.set(key, parsed);
    }
    const raw = atJsonPath(docs.get(key), field.jsonPath);
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const value = field.fromUrlFragment ? fragmentParam(raw, field.fromUrlFragment) : raw;
    if (value === undefined || value.length === 0) continue;
    out.push({
      label: field.label,
      value,
      ...(field.fragmentKey ? { fragmentKey: field.fragmentKey } : {}),
    });
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

/**
 * `baseUrl` carrying the box's service agent's sign-in fields, or `baseUrl`
 * unchanged when the box hosts no service agent and when the daemon has no
 * token to give yet.
 *
 * The browser INSIDE the box needs this for exactly the reason the host's does:
 * point it at the bare web URL and openclaw's Control UI opens on its token
 * prompt, so the VNC desktop shows a login screen instead of the dashboard. The
 * VNC path resolves its own target (it must — the host's `127.0.0.1:<forward>`
 * is nothing inside the box), which is what left it as the one surface still
 * handing out an unsigned URL.
 *
 * Best-effort by contract, like every other producer here: a daemon mid-onboard
 * has no token, and the plain URL plus its own prompt beats opening nothing.
 */
export async function withServiceSignIn(
  provider: Provider,
  box: BoxRecord,
  baseUrl: string,
): Promise<string> {
  try {
    const fields = serviceAgentForBox(box)?.service?.urlFields ?? [];
    if (fields.length === 0) return baseUrl;
    return serviceSignInUrl(baseUrl, await readServiceUrlFields(provider, box, fields)) ?? baseUrl;
  } catch {
    return baseUrl;
  }
}
