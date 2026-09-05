/**
 * Reading a package's published versions from an npm registry.
 *
 * Direct HTTP rather than an `npm view` subprocess, matching what
 * `update-check.ts` already does against the same host: it keeps the parse pure
 * (tests hand it a fixture instead of stubbing `fetch`), skips npm's ~1s cold
 * start on a best-effort refresh path, and avoids `npm view`'s awkward result
 * shape (a bare object for one match, an array for several).
 *
 * It must be the FULL packument. The abbreviated document
 * (`Accept: application/vnd.npm.install-v1+json`) is far smaller but strips
 * custom top-level fields — including `agentbox.providerApiVersion`, which is
 * the whole reason we are here. Verified against the live registry. The full
 * document for these packages is 8-20 KB, which is nothing for an explicitly
 * user-initiated update.
 */

import type { PublishedPluginVersion } from './plugin-update-decision.js';

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

const SDK_PACKAGE = '@madarco/agentbox-provider-sdk';

/**
 * A scoped name has to arrive percent-encoded — `@scope/name` as a raw path
 * segment is a 404.
 */
export function packumentUrl(packageName: string, registry: string = DEFAULT_NPM_REGISTRY): string {
  const base = registry.replace(/\/+$/, '');
  return `${base}/${packageName.replace('/', '%2F')}`;
}

export interface Packument {
  distTags: Record<string, string>;
  versions: PublishedPluginVersion[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Pure. Returns null for anything that is not a usable packument. */
export function parsePackument(body: unknown): Packument | null {
  const root = asRecord(body);
  if (!root) return null;
  const versionsRaw = asRecord(root['versions']);
  if (!versionsRaw) return null;

  const versions: PublishedPluginVersion[] = [];
  for (const [version, metaRaw] of Object.entries(versionsRaw)) {
    const meta = asRecord(metaRaw);
    // A malformed entry is skipped, not fatal: one bad publish must not hide
    // every other version of the package.
    if (!meta) continue;
    const agentbox = asRecord(meta['agentbox']);
    const declared = agentbox?.['providerApiVersion'];
    const deps = asRecord(meta['dependencies']);
    const range = deps?.[SDK_PACKAGE];
    versions.push({
      version,
      ...(typeof declared === 'number' ? { providerApiVersion: declared } : {}),
      ...(typeof range === 'string' ? { sdkRange: range } : {}),
      // npm marks a deprecated version with a string reason, not a boolean.
      ...(typeof meta['deprecated'] === 'string' || meta['deprecated'] === true
        ? { deprecated: true }
        : {}),
    });
  }

  const tagsRaw = asRecord(root['dist-tags']) ?? {};
  const distTags: Record<string, string> = {};
  for (const [tag, v] of Object.entries(tagsRaw)) if (typeof v === 'string') distTags[tag] = v;

  return { distTags, versions };
}

/**
 * `not-found` is kept separate from `unreachable` on purpose: they send the user
 * to completely different places. A 404 means the registry answered and does not
 * carry this package — a wrong name, or a private registry that does not mirror
 * it — while `unreachable` is a network or registry-URL problem. Reporting both
 * as "could not reach the registry" sends someone to debug their connection when
 * the connection is fine.
 *
 * Never degrades into installing a dist-tag blindly: unlike the CLI's own
 * self-update, the compatibility gate is exactly what is in question here.
 */
export type PackumentResult =
  | { ok: true; packument: Packument }
  | { ok: false; reason: 'not-found' | 'unreachable' };

export async function fetchPluginPackument(
  packageName: string,
  opts: { registry?: string; timeoutMs?: number } = {},
): Promise<PackumentResult> {
  const { registry = DEFAULT_NPM_REGISTRY, timeoutMs = 5000 } = opts;
  try {
    const res = await fetch(packumentUrl(packageName, registry), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { ok: false, reason: 'not-found' };
    if (!res.ok) return { ok: false, reason: 'unreachable' };
    const parsed = parsePackument(await res.json());
    // A 200 carrying something that is not a packument is a broken registry, not
    // a missing package.
    return parsed === null ? { ok: false, reason: 'unreachable' } : { ok: true, packument: parsed };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
