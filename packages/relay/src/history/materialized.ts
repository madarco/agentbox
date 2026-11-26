import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STATE_DIR } from '@agentbox/config';

/**
 * The files the hub wrote into this PC's agent folders from `history.db`
 * (usage dashboard Phase 4a, "materialize box sessions where the agents look").
 * The hub's materializer is its only writer. It is how the materializer tells
 * its own copy from a file the host's agent wrote (never overwritten), and how
 * the host-session watcher keeps a box session from shipping back as a host one.
 */
export const MATERIALIZED_FILE = join(STATE_DIR, 'hub', 'history-materialized.json');

export interface MaterializedEntry {
  /** `<agent>:<sessionId>`. */
  session: string;
  /** The hub file row and the bytes of it the copy holds. */
  fileId: number;
  generation: number;
  offset: number;
  /** The copy as written, to notice the host's agent appending to it. */
  size: number;
  mtimeMs: number;
}

export interface MaterializedManifest {
  version: 1;
  /** Keyed by the absolute path written. */
  files: Record<string, MaterializedEntry>;
}

export async function readMaterialized(
  file: string = MATERIALIZED_FILE,
): Promise<MaterializedManifest> {
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as Partial<MaterializedManifest>;
    if (v && v.version === 1 && v.files && typeof v.files === 'object') {
      return { version: 1, files: v.files };
    }
  } catch {
    /* missing or unreadable: start empty */
  }
  return { version: 1, files: {} };
}

export async function writeMaterialized(
  m: MaterializedManifest,
  file: string = MATERIALIZED_FILE,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(tmp, JSON.stringify(m), { mode: 0o600 });
  await rename(tmp, file);
}
