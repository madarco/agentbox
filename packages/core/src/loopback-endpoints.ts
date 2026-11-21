/**
 * Model endpoints in the HOST's agent config that point at host loopback.
 *
 * `http://127.0.0.1:4000/v1` in `~/.codex/config.toml` means "a gateway on this
 * machine". Copied into a box verbatim it addresses the box itself, and the
 * agent either retries forever or silently talks to whatever the box runs on
 * that port (#403). The host config was written for the host, so a loopback URL
 * there means the host by construction: on local docker it is rewritten to the
 * alias the box resolves to the host; everywhere else nothing in the box can
 * reach it, so it is only reported.
 *
 * Each agent knows WHERE its endpoints live (a TOML table, a settings `env`
 * block, a provider subtree); everything about recognizing, rewriting and
 * wording them is here, so the four agents cannot drift.
 */

import { readFile } from 'node:fs/promises';

/** The name a local docker box resolves to the host (`--add-host … host-gateway`). */
export const DOCKER_HOST_ALIAS = 'host.docker.internal';

export interface LoopbackEndpoint {
  /** Where it was found, e.g. `~/.codex/config.toml model_providers.gw.base_url`. */
  where: string;
  /** The URL exactly as the host config has it. */
  url: string;
  /** Effective TCP port (explicit, or the scheme default). */
  port: number;
  /** The URL written into the box instead, when it was rewritten. */
  rewrittenTo?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

// scheme://[userinfo@]host — the host is group 2, matched on the raw string so a
// rewrite changes nothing else (`new URL().toString()` would append a `/` to a
// bare origin, which changes how clients join paths onto a base URL).
const URL_HOST = /^([a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?)(\[[^\]]*\]|[^:/?#]*)/i;

export function isLoopbackUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The URL with its loopback host replaced by `host`, or null when it is not loopback. */
export function rewriteLoopbackUrl(url: string, host: string): string | null {
  if (!isLoopbackUrl(url)) return null;
  const m = URL_HOST.exec(url);
  if (!m) return null;
  return `${m[1] ?? ''}${host}${url.slice(m[0].length)}`;
}

function effectivePort(url: string): number {
  const u = new URL(url);
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

/** Path matcher: one entry per segment, `*` matches any key or array index. */
export type EndpointPath = readonly string[];

function matches(pattern: EndpointPath, path: readonly string[]): boolean {
  if (pattern.length !== path.length) return false;
  return pattern.every((seg, i) => seg === '*' || seg === path[i]);
}

export interface FindLoopbackOptions {
  /** Paths whose string values are endpoints (`['model_providers', '*', 'base_url']`). */
  paths: readonly EndpointPath[];
  /** Prefix for {@link LoopbackEndpoint.where}, usually the host file (`~/.codex/config.toml`). */
  source: string;
  /** Rewrite matches to this host IN PLACE. Absent = report only. */
  rewriteHost?: string;
}

/**
 * Walk a parsed config and collect (optionally rewriting in place) every
 * loopback URL at one of `opts.paths`. Mutates `root` only when `rewriteHost`
 * is set.
 */
export function findLoopbackEndpoints(
  root: unknown,
  opts: FindLoopbackOptions,
): LoopbackEndpoint[] {
  const found: LoopbackEndpoint[] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (node === null || typeof node !== 'object') return;
    const entries: [string, unknown][] = Array.isArray(node)
      ? node.map((v, i) => [String(i), v])
      : Object.entries(node as Record<string, unknown>);
    for (const [key, value] of entries) {
      const here = [...path, key];
      if (typeof value === 'string' && opts.paths.some((p) => matches(p, here))) {
        if (!isLoopbackUrl(value)) continue;
        const endpoint: LoopbackEndpoint = {
          where: `${opts.source} ${here.join('.')}`,
          url: value,
          port: effectivePort(value),
        };
        const rewritten = opts.rewriteHost ? rewriteLoopbackUrl(value, opts.rewriteHost) : null;
        if (rewritten !== null) {
          (node as Record<string, unknown>)[key] = rewritten;
          endpoint.rewrittenTo = rewritten;
        }
        found.push(endpoint);
      } else {
        walk(value, here);
      }
    }
  };
  walk(root, []);
  return found;
}

/**
 * Strip `//` and `/* *\/` comments and trailing commas outside strings, so a
 * JSONC config (`opencode.jsonc`) parses with `JSON.parse`.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export interface JsonEndpointRewrite {
  /** The text to write into the box; equals the input when nothing was rewritten. */
  text: string;
  endpoints: LoopbackEndpoint[];
  /** True when `text` differs from the input. */
  changed: boolean;
}

/**
 * Find (and with `rewriteHost`, rewrite) loopback endpoints in JSON / JSONC
 * text. A rewrite replaces only the quoted URL literals, so comments and
 * formatting survive; it falls back to re-serializing only when a literal is
 * not found verbatim (an escaped `\/` in the source). Throws on unparseable
 * input — callers keep the file as-is.
 */
export function rewriteLoopbackInJsonText(
  text: string,
  opts: FindLoopbackOptions,
): JsonEndpointRewrite {
  const parsed: unknown = JSON.parse(stripJsonComments(text));
  const endpoints = findLoopbackEndpoints(parsed, opts);
  const rewrites = endpoints.filter((e) => e.rewrittenTo !== undefined);
  if (rewrites.length === 0) return { text, endpoints, changed: false };
  let out = text;
  for (const e of rewrites) {
    const literal = JSON.stringify(e.url);
    if (!out.includes(literal)) {
      return { text: JSON.stringify(parsed, null, 2) + '\n', endpoints, changed: true };
    }
    out = out.split(literal).join(JSON.stringify(e.rewrittenTo));
  }
  return { text: out, endpoints, changed: true };
}

/**
 * {@link rewriteLoopbackInJsonText} over a file. A missing or unparseable file
 * yields `null` — sync must never fail on endpoint inspection.
 */
export async function rewriteLoopbackInJsonFile(
  file: string,
  opts: FindLoopbackOptions,
): Promise<JsonEndpointRewrite | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return rewriteLoopbackInJsonText(text, opts);
  } catch {
    return null;
  }
}

/** One line per rewritten endpoint, for the docker create log. */
export function formatLoopbackRewrite(agent: string, e: LoopbackEndpoint): string {
  return `${agent}: ${e.where} ${e.url} -> ${e.rewrittenTo ?? e.url} (host loopback, reached via ${DOCKER_HOST_ALIAS} in the box)`;
}

/** For boxes that cannot reach the host at all (cloud providers). */
export function formatLoopbackUnreachable(agent: string, e: LoopbackEndpoint): string {
  return (
    `${agent}: ${e.where} is ${e.url}, which inside a cloud box is the box itself, ` +
    'not this machine: requests to it will fail. Point it at an address the box can reach ' +
    '(a public URL or a tunnel).'
  );
}

/** Report-only scan of several host JSON/JSONC files (the cloud path). */
export async function scanLoopbackJsonFiles(
  files: readonly { src: string; paths: readonly EndpointPath[]; source: string }[],
): Promise<LoopbackEndpoint[]> {
  const found: LoopbackEndpoint[] = [];
  for (const f of files) {
    const r = await rewriteLoopbackInJsonFile(f.src, { paths: f.paths, source: f.source });
    if (r) found.push(...r.endpoints);
  }
  return found;
}
