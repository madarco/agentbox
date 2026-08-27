/**
 * The custody-backed cache behind `cp fromHost` — what makes a copy from your
 * machine still answer when your machine is asleep.
 *
 * A live copy writes its bytes here on the way past; a copy that finds nobody
 * home reads them back. The same entries are what `agentbox cp <file> hub:`
 * writes, so "pre-load a file for my boxes" and "warm the cache" are one
 * operation rather than two features.
 *
 * Keyed by the **resolved absolute host path**, hashed: custody path segments
 * are a flat `[A-Za-z0-9._-]` namespace, and a hash is the only way to put
 * `/Users/marco/data/q3.csv` in one. Two boxes of the same project asking for
 * the same file therefore share an entry, which is the point — the cache is per
 * project, not per box.
 *
 * Every entry is a tar, even for a single file: it carries the name and mode
 * with it, so unpacking on the far side needs no second channel to know what it
 * is looking at.
 */

import { createHash } from 'node:crypto';

/** Sidecar recorded next to each cached tar. */
export interface CpCacheMeta {
  /** Absolute host path this entry was captured from. */
  sourcePath: string;
  /** True when the tar holds a directory tree rather than one file. */
  isDir: boolean;
  /** ISO timestamp of the capture. */
  capturedAt: string;
  /** Bytes of the tar. */
  size: number;
  /** Hostname of the machine it came from — an entry outlives the session that wrote it. */
  capturedOn?: string;
}

/**
 * Custody prefix for a project's cp cache. `originUrl`-derived slug when the
 * box has one; otherwise the box's own id, so a box with no remote still gets a
 * (narrower) cache instead of none.
 */
export function cpCachePrefix(opts: { projectSlug?: string; boxId: string }): string {
  const slug = (opts.projectSlug ?? '').trim();
  return slug.length > 0 ? `projects/${slug}/cp` : `boxes/${opts.boxId}/cp`;
}

/** Hex sha256 of a resolved host path — the cache key's single segment. */
export function cpCacheKey(absHostPath: string): string {
  return createHash('sha256').update(absHostPath).digest('hex').slice(0, 32);
}

/** Custody path of the tar for `absHostPath` under `prefix`. */
export function cpCacheTarPath(prefix: string, absHostPath: string): string {
  return `${prefix}/${cpCacheKey(absHostPath)}.tar`;
}

/** Custody path of the sidecar metadata for `absHostPath` under `prefix`. */
export function cpCacheMetaPath(prefix: string, absHostPath: string): string {
  return `${prefix}/${cpCacheKey(absHostPath)}.json`;
}

/**
 * Human phrasing of a cached entry's age, for the approval detail and the line
 * the box sees. An agent that reads "cached" without "from when" has no way to
 * judge whether it is looking at today's data or last month's.
 */
export function describeCacheAge(capturedAt: string, now: number = Date.now()): string {
  const then = Date.parse(capturedAt);
  if (!Number.isFinite(then)) return 'captured at an unknown time';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 90) return `captured ${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `captured ${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `captured ${String(hours)}h ago`;
  return `captured ${String(Math.round(hours / 24))}d ago`;
}

/** Parse a sidecar, or null when it is missing/corrupt (treated as no cache). */
export function parseCpCacheMeta(raw: string): CpCacheMeta | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CpCacheMeta>;
    if (typeof parsed.sourcePath !== 'string' || typeof parsed.capturedAt !== 'string') return null;
    return {
      sourcePath: parsed.sourcePath,
      isDir: parsed.isDir === true,
      capturedAt: parsed.capturedAt,
      size: typeof parsed.size === 'number' ? parsed.size : 0,
      ...(typeof parsed.capturedOn === 'string' ? { capturedOn: parsed.capturedOn } : {}),
    };
  } catch {
    return null;
  }
}
