/**
 * Byte-offset tail of a create job's progress log
 * (`~/.agentbox/logs/queue-<jobId>.log`, written by the hub worker's job logger).
 *
 * This is what lets a PC watching a hub-routed create see the same lines a local
 * create prints: the `/remote/boxes/:id/logs` route hands this back, and the
 * CLI's poll loop drains it between status checks. Deliberately fs-only — the
 * `/remote/boxes` dispatcher stays framework-agnostic and injects this, so the
 * serverless plane (which has no such file) simply doesn't wire it.
 */

import { open, stat } from 'node:fs/promises';
import { queueLogPath } from './queue.js';
import { isSafeJobId } from './remote-boxes.js';

/** Per-response ceiling. A busy job just gets drained over several polls. */
const MAX_BYTES_PER_READ = 64 * 1024;

export interface JobLogTail {
  /** Whole lines appended since the requested offset. */
  lines: string[];
  /** Byte offset to pass to the next call — never mid-line. */
  offset: number;
}

/**
 * Read whole lines appended to job `id`'s log after `offset`.
 *
 * A missing file is normal, not an error: the job can be claimed a tick before
 * the worker writes its first line, and a job that never ran has no log at all.
 * The id is re-checked here so this is safe to call from anywhere, not only
 * from behind the route's own {@link isSafeJobId} gate.
 * The returned offset only ever advances past complete lines, so a read that
 * lands mid-line re-reads that line's bytes next time rather than emitting a
 * truncated line or dropping it.
 */
export async function readCreateJobLog(id: string, offset: number): Promise<JobLogTail> {
  const from = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  if (!isSafeJobId(id)) return { lines: [], offset: from };
  const path = queueLogPath(id);

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { lines: [], offset: from };
  }
  // A truncated/rotated file (size < offset) restarts the tail from the top
  // rather than reading past EOF forever.
  const start = size < from ? 0 : from;
  if (size <= start) return { lines: [], offset: start };

  const len = Math.min(size - start, MAX_BYTES_PER_READ);
  const buf = Buffer.alloc(len);
  const fh = await open(path, 'r');
  try {
    await fh.read(buf, 0, len, start);
  } finally {
    await fh.close();
  }

  const chunk = buf.toString('utf8');
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline < 0) {
    // No complete line in this window. Only possible for a single line longer
    // than the cap — hand it over and move on, or the tail would wedge here.
    return len >= MAX_BYTES_PER_READ
      ? { lines: [chunk], offset: start + len }
      : { lines: [], offset: start };
  }
  const complete = chunk.slice(0, lastNewline);
  const consumed = Buffer.byteLength(complete, 'utf8') + 1;
  return {
    lines: complete.split('\n').filter((l) => l.length > 0),
    offset: start + consumed,
  };
}
