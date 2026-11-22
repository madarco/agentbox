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

async function readAll(file: string): Promise<CheckoutRecord[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { checkouts?: unknown };
    return Array.isArray(parsed.checkouts) ? parsed.checkouts.filter(isRecord) : [];
  } catch {
    return [];
  }
}

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
  const all = await readAll(file);
  return all.filter((r) => matches(r, filter)).sort((a, b) => b.seenAt.localeCompare(a.seenAt));
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
  const seenAt = (opts.now ?? (() => new Date()))().toISOString();
  return withFileLock(
    file,
    async () => {
      const all = await readAll(file);
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
