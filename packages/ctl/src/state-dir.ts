import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LOG_DIR, DEFAULT_STATE_DIR } from './types.js';

/**
 * Resolve a writable base directory for supervisor/render state (run_once task
 * markers, generated secrets). Prefer `want` (default /var/lib/agentbox — box
 * rootfs, checkpoint-captured, off /workspace), but the daemon runs as a
 * non-root user and that dir is root-owned on stock images, so fall back to
 * `<logDir>/state` (always daemon-writable, also on rootfs). Writability is
 * probed by creating `<dir>/<ensureSubdir>` (a no-op mkdir on an existing but
 * unwritable root-owned dir would otherwise look like success). Returns the
 * resolved base; the caller uses its own subdir under it.
 */
export async function resolveWritableStateDir(
  want: string = DEFAULT_STATE_DIR,
  logDir: string = DEFAULT_LOG_DIR,
  ensureSubdir = 'tasks',
  onNotice?: (msg: string) => void,
): Promise<string> {
  try {
    await mkdir(join(want, ensureSubdir), { recursive: true });
    return want;
  } catch {
    const fallback = join(logDir, 'state');
    try {
      await mkdir(join(fallback, ensureSubdir), { recursive: true });
      onNotice?.(`${want} not writable, using ${fallback}`);
      return fallback;
    } catch {
      return want; // give up; the caller's write will surface the error
    }
  }
}
