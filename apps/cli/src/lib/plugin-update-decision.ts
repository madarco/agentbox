/**
 * Which registered provider plugins `self-update` should move, and to what.
 *
 * Pure: no fs, no network, no npm. The caller reads the registry, classifies how
 * each package was installed, and fetches the registry metadata; this file owns
 * the rules. Same shape as `decideSelfUpdate` / `decideHubUpdate`, and for the
 * same reason — the interesting part is the policy, and policy is only testable
 * if it does no I/O.
 *
 * The policy in one line: install the newest published version whose provider
 * SDK major this build actually supports. NOT `@latest`. A user on a CLI whose
 * gate is [1,2] must not be moved onto a v4-only plugin build — that would
 * break a plugin that works today, which is the exact failure this feature
 * exists to prevent.
 */

import { compareSemver } from './semver-lite.js';
import type { PluginInstallKind } from './plugin-install-root.js';

/** One published version, reduced to what the gate cares about. Transport-agnostic. */
export interface PublishedPluginVersion {
  version: string;
  /**
   * package.json `agentbox.providerApiVersion`. Authoritative, because it is
   * literally the field `resolvePackage` reads and `loadAndValidate` gates on.
   */
  providerApiVersion?: number;
  /** package.json `dependencies['@madarco/agentbox-provider-sdk']`, as published. */
  sdkRange?: string;
  /** npm `deprecated` — never auto-installed. */
  deprecated?: boolean;
}

export interface PluginUpdateCandidate {
  packageName: string;
  installedVersion: string;
  /** May already be unsupported — that is the whole point of this pass. */
  installedApiVersion: number;
  install: PluginInstallKind;
  /** undefined = the registry could not be reached. [] = reached, nothing published. */
  published: PublishedPluginVersion[] | undefined;
}

export interface PluginUpdateInput {
  candidates: PluginUpdateCandidate[];
  /** `SUPPORTED_SDK_API_VERSIONS` of the binary that will load the result. */
  supportedMajors: readonly number[];
  skipFlag: boolean;
}

export type PluginUpdateOutcome =
  | {
      action: 'update';
      packageName: string;
      from: string;
      to: string;
      toApiVersion: number;
      source: ApiVersionSource;
      manager: 'npm' | 'pnpm';
      /**
       * `downgrade-to-compatible` is a deliberate backward move, the mirror of
       * `decideSelfUpdate`'s `switching`: the installed build is refused by this
       * gate, so an older compatible release is strictly better than nothing.
       */
      reason: 'newer' | 'downgrade-to-compatible';
    }
  | { action: 'already-newest'; packageName: string; version: string }
  | {
      action: 'no-compatible-version';
      packageName: string;
      installedVersion: string;
      installedApiVersion: number;
      newestPublished: string | undefined;
      reason: 'all-incompatible' | 'no-api-version-metadata';
    }
  | { action: 'skipped-path'; packageName: string; reason: 'path' | 'linked' }
  | { action: 'skipped-missing'; packageName: string; installedVersion: string }
  | { action: 'skipped-flag'; packageName: string }
  | { action: 'unknown'; packageName: string; reason: 'offline' };

export type ApiVersionSource = 'declared' | 'sdk-range' | 'none';

/**
 * Majors a comparator set admits, or null when the range says nothing usable.
 *
 * Dependency-free on purpose (`semver-lite.ts` sets the precedent). We only need
 * "which majors could this resolve to", never full range satisfaction.
 */
export function majorsFromRange(range: string): number[] | null {
  const trimmed = range.trim();
  if (trimmed === '') return null;
  // A non-registry specifier resolves to whatever that source happens to hold,
  // which registry metadata cannot tell us.
  if (/^(workspace:|file:|link:|git|https?:|github:|npm:)/i.test(trimmed)) return null;

  const out = new Set<number>();
  for (const alternative of trimmed.split('||')) {
    for (const raw of alternative.trim().split(/\s+/)) {
      if (raw === '') continue;
      // `<` / `<=` is the EXCLUSIVE upper bound of a range: `>=4 <5` admits 4,
      // not 5. Reading it as a candidate major is the one mistake here that
      // would silently install a major we do not support.
      if (/^<=?/.test(raw)) continue;
      const bare = raw.replace(/^[\^~]|^[><]=?|^=/, '').replace(/^v/i, '');
      const m = /^(\d+)/.exec(bare);
      if (m) out.add(Number(m[1]));
    }
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : null;
}

/** What gate outcome a published version would get, and how confidently we know. */
export function publishApiVersion(
  v: PublishedPluginVersion,
  supported: readonly number[],
): { apiVersion: number | null; source: ApiVersionSource; compatible: boolean } {
  // Declared wins outright, even against a disagreeing dep range: anything else
  // would predict a gate outcome different from the one actually applied after
  // install.
  if (typeof v.providerApiVersion === 'number') {
    return {
      apiVersion: v.providerApiVersion,
      source: 'declared',
      compatible: supported.includes(v.providerApiVersion),
    };
  }
  const majors = v.sdkRange === undefined ? null : majorsFromRange(v.sdkRange);
  if (majors) {
    const hits = majors.filter((m) => supported.includes(m));
    return {
      apiVersion: hits.length > 0 ? Math.max(...hits) : Math.max(...majors),
      source: 'sdk-range',
      compatible: hits.length > 0,
    };
  }
  // Neither signal: NOT a candidate. Installing a version whose gate outcome is
  // unknown is precisely the blind-`@latest` behaviour this policy rejects.
  return { apiVersion: null, source: 'none', compatible: false };
}

function isPrerelease(v: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(v.trim());
}

function newestOf(versions: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const v of versions) {
    if (best === undefined || compareSemver(v, best) === 1) best = v;
  }
  return best;
}

function decideOne(c: PluginUpdateCandidate, supported: readonly number[]): PluginUpdateOutcome {
  switch (c.install.kind) {
    case 'missing':
      return {
        action: 'skipped-missing',
        packageName: c.packageName,
        installedVersion: c.installedVersion,
      };
    case 'path':
    case 'linked':
      // Both are a working tree the user owns. `npm i -g` against either
      // replaces it — for `linked`, silently detaching them from their checkout.
      return { action: 'skipped-path', packageName: c.packageName, reason: c.install.kind };
    default:
      break;
  }
  const manager = c.install.kind;

  if (c.published === undefined) {
    return { action: 'unknown', packageName: c.packageName, reason: 'offline' };
  }

  const installedIsPre = isPrerelease(c.installedVersion);
  const usable = c.published.filter((p) => {
    if (p.deprecated === true) return false;
    // A plugin has no channel concept, so a user who never opted into anything
    // must not be moved onto a prerelease. Someone already running one opted in
    // by hand, and would otherwise be offered nothing at all.
    if (isPrerelease(p.version) && !installedIsPre) return false;
    return true;
  });

  const compatible = usable.filter((p) => publishApiVersion(p, supported).compatible);
  const newestPublished = newestOf(c.published.map((p) => p.version));

  if (compatible.length === 0) {
    const anyMetadata = usable.some((p) => publishApiVersion(p, supported).source !== 'none');
    return {
      action: 'no-compatible-version',
      packageName: c.packageName,
      installedVersion: c.installedVersion,
      installedApiVersion: c.installedApiVersion,
      newestPublished,
      reason: anyMetadata ? 'all-incompatible' : 'no-api-version-metadata',
    };
  }

  let best: PublishedPluginVersion | undefined;
  for (const p of compatible) {
    if (best === undefined || compareSemver(p.version, best.version) === 1) best = p;
  }
  if (best === undefined) {
    return { action: 'already-newest', packageName: c.packageName, version: c.installedVersion };
  }

  const cmp = compareSemver(best.version, c.installedVersion);
  const resolved = publishApiVersion(best, supported);
  const toApiVersion = resolved.apiVersion ?? 0;

  if (cmp === 1) {
    return {
      action: 'update',
      packageName: c.packageName,
      from: c.installedVersion,
      to: best.version,
      toApiVersion,
      source: resolved.source,
      manager,
      reason: 'newer',
    };
  }

  // Strictly gated on the INSTALLED record being unsupported, so a plugin that
  // works today is never walked backwards.
  if (!supported.includes(c.installedApiVersion) && cmp !== 0) {
    return {
      action: 'update',
      packageName: c.packageName,
      from: c.installedVersion,
      to: best.version,
      toApiVersion,
      source: resolved.source,
      manager,
      reason: 'downgrade-to-compatible',
    };
  }

  return { action: 'already-newest', packageName: c.packageName, version: c.installedVersion };
}

export function decidePluginUpdates(input: PluginUpdateInput): PluginUpdateOutcome[] {
  // A map with no early exit: one unreachable or broken package must never
  // suppress the others.
  return input.candidates.map((c) =>
    input.skipFlag
      ? ({ action: 'skipped-flag', packageName: c.packageName } as const)
      : decideOne(c, input.supportedMajors),
  );
}

/** One human line per outcome, for the refresh log and `plugin update`. */
export function describePluginUpdate(o: PluginUpdateOutcome): string {
  switch (o.action) {
    case 'update':
      return o.reason === 'downgrade-to-compatible'
        ? `${o.packageName} ${o.from} -> ${o.to} (back to the newest build this CLI can load, SDK v${String(o.toApiVersion)})`
        : `${o.packageName} ${o.from} -> ${o.to} (SDK v${String(o.toApiVersion)})`;
    case 'already-newest':
      return `${o.packageName}@${o.version} is already the newest compatible release`;
    case 'no-compatible-version':
      return o.reason === 'no-api-version-metadata'
        ? `${o.packageName}@${o.installedVersion} left in place — no published release declares a provider SDK version`
        : `${o.packageName}@${o.installedVersion} left in place — no published release targets this CLI's provider SDK (newest is ${o.newestPublished ?? 'unknown'})`;
    case 'skipped-path':
      return o.reason === 'linked'
        ? `${o.packageName} skipped — npm-linked dev checkout`
        : `${o.packageName} skipped — registered from a local path`;
    case 'skipped-missing':
      return `${o.packageName}@${o.installedVersion} skipped — no longer resolvable on this machine`;
    case 'skipped-flag':
      return `${o.packageName} skipped (--skip-plugins)`;
    case 'unknown':
      return `${o.packageName} left in place — could not reach the npm registry`;
  }
}
