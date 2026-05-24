import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BoxRecord, DockerBoxFields, FindBoxResult, StateFile } from '@agentbox/core';

export const STATE_DIR = join(homedir(), '.agentbox');
export const STATE_FILE = join(STATE_DIR, 'state.json');

const EMPTY: StateFile = { version: 1, boxes: [] };

export async function readState(path: string = STATE_FILE): Promise<StateFile> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.boxes)) {
      throw new Error(`unrecognized state file shape at ${path}`);
    }
    // Migrate-on-read: records written before the multi-provider split carry no
    // `provider` field — they are all Docker boxes. Default it so every
    // consumer (provider registry, `findBox`) sees a discriminated record.
    // Also backfill `box.docker` from the flat fields for Docker records so
    // forward-looking readers (7.1) see the nested shape without waiting
    // for the box to be re-recorded.
    for (const b of parsed.boxes) {
      b.provider ??= 'docker';
      if ((b.provider ?? 'docker') === 'docker' && !b.docker) {
        b.docker = projectDockerFields(b);
      }
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY };
    }
    throw err;
  }
}

export async function writeState(state: StateFile, path: string = STATE_FILE): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export async function recordBox(box: BoxRecord, path: string = STATE_FILE): Promise<void> {
  // Forward-looking shape: every Docker write also mirrors the flat
  // docker-specific fields into `box.docker` so readers can move to the
  // nested form opportunistically (7.1). Cloud records skip the mirror —
  // the discriminator is `box.provider !== 'docker'`.
  const toWrite: BoxRecord =
    (box.provider ?? 'docker') === 'docker' && !box.docker
      ? { ...box, docker: projectDockerFields(box) }
      : box;
  const state = await readState(path);
  const next: StateFile = {
    version: 1,
    boxes: [...state.boxes.filter((b) => b.id !== toWrite.id), toWrite],
  };
  await writeState(next, path);
}

/**
 * Build a `DockerBoxFields` payload from the flat Docker-specific fields
 * still living on `BoxRecord` for back-compat. Pure function, no
 * filesystem; safe for both `readState` migration and `recordBox` mirror.
 *
 * Once every reader uses `box.docker?.<field>` (the rest of 7.1), the
 * flat fields can be dropped and this projection becomes the canonical
 * shape. Until then, every write produces both shapes from the same
 * source so they can't drift.
 */
function projectDockerFields(box: BoxRecord): DockerBoxFields {
  return {
    container: box.container,
    image: box.image,
    snapshotDir: box.snapshotDir ?? null,
    socketPath: box.socketPath,
    claudeConfigVolume: box.claudeConfigVolume,
    codexConfigVolume: box.codexConfigVolume,
    opencodeConfigVolume: box.opencodeConfigVolume,
    vscodeServerVolume: box.vscodeServerVolume,
    cursorServerVolume: box.cursorServerVolume,
    vncHostPort: box.vncHostPort,
    webHostPort: box.webHostPort,
    portlessAlias: box.portlessAlias,
    portlessUrl: box.portlessUrl,
    dockerVolume: box.dockerVolume,
    dockerCacheShared: box.dockerCacheShared,
    checkpointImage: box.checkpointImage,
  };
}

export async function removeBoxRecord(id: string, path: string = STATE_FILE): Promise<boolean> {
  const state = await readState(path);
  const before = state.boxes.length;
  const next: StateFile = {
    version: 1,
    boxes: state.boxes.filter((b) => b.id !== id),
  };
  if (next.boxes.length === before) return false;
  await writeState(next, path);
  return true;
}

/**
 * Resolve a user-supplied identifier against the state file. Matching
 * precedence mirrors `docker`'s container reference resolution:
 *
 *   1. exact id
 *   2. unique id prefix
 *   3. exact name
 *   4. exact container name
 *
 * Returns `'ambiguous'` if step 2 finds more than one match (steps 1, 3, 4
 * are exact-match so they cannot be ambiguous on their own).
 */
export function findBox(idOrName: string, state: StateFile): FindBoxResult {
  const q = idOrName.trim();
  if (q.length === 0) return { kind: 'none' };

  const exactId = state.boxes.find((b) => b.id === q);
  if (exactId) return { kind: 'ok', box: exactId };

  const prefixMatches = state.boxes.filter((b) => b.id.startsWith(q));
  if (prefixMatches.length === 1) return { kind: 'ok', box: prefixMatches[0]! };
  if (prefixMatches.length > 1) return { kind: 'ambiguous', matches: prefixMatches };

  const byName = state.boxes.find((b) => b.name === q);
  if (byName) return { kind: 'ok', box: byName };

  // For docker records `container` is the docker container name; for cloud
  // records it's `cloud:<sandboxId>` (post 7.2 — no more synthetic
  // agentbox-cloud-* prefix). Either form is a valid byContainer lookup
  // key for `findBox`.
  const byContainer = state.boxes.find((b) => b.container === q);
  if (byContainer) return { kind: 'ok', box: byContainer };

  return { kind: 'none' };
}

/**
 * Next monotonic 1-based index for the given project. Reads only `state.boxes`
 * — caller is responsible for persisting the assignment. Boxes without
 * `projectRoot` are ignored (legacy records); boxes in *other* projects are
 * also ignored. Indices are never recycled, so a destroyed #2 leaves a gap.
 */
export function allocateProjectIndex(state: StateFile, projectRoot: string): number {
  let max = 0;
  for (const b of state.boxes) {
    if (b.projectRoot !== projectRoot) continue;
    if (typeof b.projectIndex === 'number' && b.projectIndex > max) {
      max = b.projectIndex;
    }
  }
  return max + 1;
}

/**
 * Auto-pick when a command's `[box]` argument is omitted. Returns the unique
 * box for `projectRoot`, an `ambiguous` carrying all candidates so the CLI can
 * print a chooser, or `none`.
 */
export function autoPickProjectBox(state: StateFile, projectRoot: string): FindBoxResult {
  const matches = state.boxes.filter((b) => b.projectRoot === projectRoot);
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'ok', box: matches[0]! };
  return { kind: 'ambiguous', matches };
}

/**
 * Top-level resolver every CLI command goes through. Combines numeric-index
 * lookup with the legacy `findBox` matcher:
 *
 *   - `ref === undefined` and `projectRoot` known → autoPickProjectBox.
 *   - `ref` is a pure positive integer and `projectRoot` known → resolve as
 *     project index. **Never** falls through to `findBox` on miss, so
 *     `agentbox open 3` is reserved for the index and won't accidentally
 *     match a hex id like `3abc…`.
 *   - Otherwise → `findBox` (id → prefix → name → container).
 */
export function resolveBoxRef(
  ref: string | undefined,
  state: StateFile,
  projectRoot: string | undefined,
): FindBoxResult {
  if (ref === undefined) {
    if (projectRoot === undefined) return { kind: 'none' };
    return autoPickProjectBox(state, projectRoot);
  }
  const trimmed = ref.trim();
  if (projectRoot !== undefined && /^[1-9][0-9]*$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10);
    const hit = state.boxes.find(
      (b) => b.projectRoot === projectRoot && b.projectIndex === idx,
    );
    return hit ? { kind: 'ok', box: hit } : { kind: 'none' };
  }
  return findBox(trimmed, state);
}
