import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Cross-process lock tunables. The lock guards a read-modify-write of a file
// several agentbox processes share — two concurrent image bakes, for instance,
// both pin their `box.image<Provider>` into the global config from separate
// detached workers. Held for one read+write (sub-millisecond), so contention
// clears fast.
const LOCK_STALE_MS = 15_000; // a lock older than this is presumed abandoned
const LOCK_ACQUIRE_TIMEOUT_MS = 20_000;
const LOCK_RETRY_MS = 25;

/**
 * Run `fn` while holding an exclusive cross-process lock on `${path}.lock`.
 *
 * Acquisition: create the lockfile with `wx` (O_EXCL) — atomic on local FSes.
 * On contention, retry with a short backoff until {@link LOCK_ACQUIRE_TIMEOUT_MS};
 * a lockfile older than {@link LOCK_STALE_MS} is treated as abandoned (crashed
 * holder) and forcibly broken. If the lock still can't be taken before the
 * timeout we proceed anyway — the write itself is atomic (temp+rename) so the
 * worst case degrades to a possible lost update, never a corrupt file. The lock
 * is always released in `finally`.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.writeFile(`${String(process.pid)}\n`);
      await fh.close();
      held = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Break a stale lock left by a crashed holder.
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // lock vanished between open and stat — retry immediately
        continue;
      }
      if (Date.now() >= deadline) break; // give up waiting; proceed best-effort
      await delay(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    if (held) await rm(lockPath, { force: true }).catch(() => {});
  }
}
