import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { withFileLock } from '@agentbox/config';
import { STATE_DIR } from '@agentbox/sandbox-core';
import type { CheckoutFilter, CheckoutRecord, CheckoutReport } from './types.js';

/** The registry file: one JSON list, on the hub that owns the boxes. */
export const CHECKOUTS_FILE = join(STATE_DIR, 'hub', 'checkouts.json');

/** Same short windows as the workspace store: this sits on a poll path. */
const CHECKOUTS_LOCK = { staleMs: 2_000, acquireTimeoutMs: 5_000 };

function isRecord(v: unknown): v is CheckoutRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.repoKey === 'string' &&
    typeof r.machineId === 'string' &&
    typeof r.folder === 'string' &&
    typeof r.label === 'string' &&
    typeof r.seenAt === 'string'
  );
}

/** A registry file that exists but cannot be used. Never silently overwritten. */
export class CheckoutsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutsFileError';
  }
}

/**
 * Read the registry. A missing file is an empty registry; an UNREADABLE one
 * (EACCES, EIO) throws, so the next write cannot replace it with a near-empty
 * list. A corrupt one throws on a read, and on a write is first moved aside to
 * `<file>.corrupt-<time>` so nothing is lost.
 */
async function readAll(
  file: string,
  opts: { forWrite?: boolean; now?: Date } = {},
): Promise<CheckoutRecord[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new CheckoutsFileError(
      `cannot read the checkouts registry ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: { checkouts?: unknown };
  try {
    parsed = JSON.parse(raw) as { checkouts?: unknown };
  } catch {
    if (!opts.forWrite) {
      throw new CheckoutsFileError(`the checkouts registry ${file} is not valid JSON`);
    }
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    await rename(file, `${file}.corrupt-${stamp}`);
    return [];
  }
  return Array.isArray(parsed.checkouts) ? parsed.checkouts.filter(isRecord) : [];
}

/**
 * A row no report has named for this long is dropped on the next write: a
 * machine that was wiped or retired never sends the `removed` that would
 * clear its rows, and Phase 4 would keep offering it as a candidate.
 */
export const CHECKOUT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

async function writeAll(file: string, checkouts: CheckoutRecord[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, checkouts }, null, 2) + '\n', {
    mode: 0o600,
  });
  await rename(tmp, file);
}

function matches(r: CheckoutRecord, filter: CheckoutFilter): boolean {
  if (filter.repoKey !== undefined && r.repoKey !== filter.repoKey) return false;
  if (filter.machineId !== undefined && r.machineId !== filter.machineId) return false;
  return true;
}

/** Registered checkouts, newest report first. */
export async function listCheckouts(
  filter: CheckoutFilter = {},
  file: string = CHECKOUTS_FILE,
): Promise<CheckoutRecord[]> {
  const cutoff = Date.now() - CHECKOUT_MAX_AGE_MS;
  const all = await readAll(file);
  return all
    .filter((r) => matches(r, filter) && Date.parse(r.seenAt) >= cutoff)
    .sort((a, b) => b.seenAt.localeCompare(a.seenAt));
}

const sameRow = (a: { repoKey: string; folder: string }, b: { repoKey: string; folder: string }) =>
  a.repoKey === b.repoKey && a.folder === b.folder;

/**
 * Apply one machine's report. Idempotent: the last report per
 * `(repoKey, machineId, folder)` wins, and only that machine's own rows can be
 * removed by it.
 */
export async function applyCheckoutReport(
  report: CheckoutReport,
  opts: { file?: string; now?: () => Date } = {},
): Promise<CheckoutRecord[]> {
  const file = opts.file ?? CHECKOUTS_FILE;
  const now = (opts.now ?? (() => new Date()))();
  const seenAt = now.toISOString();
  const cutoff = now.getTime() - CHECKOUT_MAX_AGE_MS;
  return withFileLock(
    file,
    async () => {
      const all = (await readAll(file, { forWrite: true, now })).filter(
        (r) => Date.parse(r.seenAt) >= cutoff,
      );
      const removed = report.removed ?? [];
      const kept = all.filter(
        (r) =>
          r.machineId !== report.machineId ||
          !(removed.some((x) => sameRow(x, r)) || report.entries.some((e) => sameRow(e, r))),
      );
      const byRow = new Map<string, CheckoutRecord>();
      for (const e of report.entries) {
        byRow.set(`${e.repoKey}\0${e.folder}`, {
          repoKey: e.repoKey,
          machineId: report.machineId,
          folder: e.folder,
          label: report.label,
          seenAt,
          ...(e.head ? { head: e.head } : {}),
        });
      }
      const fresh = [...byRow.values()];
      const next = [...kept, ...fresh];
      await writeAll(file, next);
      return fresh;
    },
    CHECKOUTS_LOCK,
  );
}
