import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  BoxRecord,
  DockerBoxFields,
  FindBoxResult,
  SshTargetRecord,
  StateFile,
} from '@agentbox/core';

export const STATE_DIR = join(homedir(), '.agentbox');
export const STATE_FILE = join(STATE_DIR, 'state.json');

const EMPTY: StateFile = { version: 1, boxes: [] };

// Cross-process lock tunables. The lock guards the read-modify-write of
// `state.json` so concurrent `agentbox create`/`destroy` processes can't lose
// each other's records or interleave a half-written file. Held only for the
// duration of one read+write (sub-millisecond), so contention clears fast even
// with a burst of parallel creates.
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
 * timeout we proceed anyway — the write is atomic (temp+rename) so the worst
 * case degrades to a possible lost update, never a corrupt file. The lock is
 * always released in `finally`.
 */
async function withStateLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
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

/**
 * Locked read-modify-write of the state file. `mutator` receives the current
 * state and returns the next one; the read and the (atomic) write happen under
 * the same lock so concurrent mutators serialize instead of clobbering.
 */
export async function mutateState(
  mutator: (state: StateFile) => StateFile,
  path: string = STATE_FILE,
): Promise<void> {
  await withStateLock(path, async () => {
    const state = await readState(path);
    await writeState(mutator(state), path);
  });
}

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
      // The SSH target moved from `box.cloud.ssh` to top-level `box.ssh`.
      // Backfill on read so an already-created box (e.g. a Hetzner box) keeps its
      // `~/.agentbox/ssh/config` alias — `syncAgentboxSshConfig` only reads
      // `box.ssh`, and it would otherwise vanish until the box is next started.
      const legacySsh = (b.cloud as { ssh?: SshTargetRecord } | undefined)?.ssh;
      if (!b.ssh && legacySsh) b.ssh = legacySsh;
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
  // Atomic: write a sibling temp file then rename over the target. rename(2) is
  // atomic on local filesystems, so a concurrent writer (or a reader) never
  // observes a half-written / interleaved JSON file. The pid+time suffix keeps
  // parallel writers from colliding on the temp path itself.
  const tmp = `${path}.tmp.${String(process.pid)}.${String(Date.now())}`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
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
  await mutateState(
    (state) => ({
      version: 1,
      boxes: [...state.boxes.filter((b) => b.id !== toWrite.id), toWrite],
    }),
    path,
  );
}

/**
 * Record which agent was last launched in a box (`agentbox claude` / `codex` /
 * `opencode`). A locked read-modify-write so it can't clobber a concurrent
 * state change. No-op when the box isn't in state (a race with `destroy`).
 * `agentbox recover` reads `box.lastAgent` to decide which agent to relaunch.
 */
export async function recordLastAgent(
  boxId: string,
  kind: 'claude' | 'codex' | 'opencode',
  path: string = STATE_FILE,
): Promise<void> {
  await mutateState(
    (state) => ({
      version: 1,
      boxes: state.boxes.map((b) => (b.id === boxId ? { ...b, lastAgent: kind } : b)),
    }),
    path,
  );
}

/**
 * Set (or clear) a box's cosmetic `displayName`. A locked read-modify-write so
 * it can't clobber a concurrent state change. Trims the input; an empty/blank
 * value clears the label (falls back to `name`). No-op when the box isn't in
 * state (a race with `destroy`). The label is display/lookup-only — it does not
 * touch the container, git branch, or URL. Reused by the CLI and the hub.
 */
export async function setBoxDisplayName(
  boxId: string,
  displayName: string | undefined,
  path: string = STATE_FILE,
): Promise<void> {
  const trimmed = displayName?.trim();
  const next = trimmed ? trimmed : undefined;
  await mutateState(
    (state) => ({
      version: 1,
      boxes: state.boxes.map((b) => {
        if (b.id !== boxId) return b;
        if (next) return { ...b, displayName: next };
        const rest = { ...b };
        delete rest.displayName;
        return rest;
      }),
    }),
    path,
  );
}

/**
 * Persist a box's last resolved SSH target (`box.ssh`). A locked
 * read-modify-write so it can't clobber a concurrent state change. No-op when
 * the box isn't in state (a race with `destroy`). Works for any provider — the
 * docker localhost sshd (host `127.0.0.1` + ephemeral `port`) and cloud
 * providers (Hetzner VPS IP) both land here. `syncAgentboxSshConfig` reads it
 * back to regenerate `~/.agentbox/ssh/config` offline, without re-resolving the
 * target from the provider.
 */
export async function recordBoxSsh(
  boxId: string,
  ssh: { host: string; user: string; identityFile?: string; port?: number; proxyJump?: string },
  path: string = STATE_FILE,
): Promise<void> {
  await mutateState(
    (state) => ({
      version: 1,
      boxes: state.boxes.map((b) => (b.id === boxId ? { ...b, ssh } : b)),
    }),
    path,
  );
}

/**
 * Atomically allocate the next per-project index AND persist `record` claiming
 * it, under the state lock. Returns the reserved index (also stamped onto the
 * persisted record).
 *
 * Callers bake this index into on-disk paths (`<id>-<n>-<mnemonic>` box dir,
 * socket, snapshot), and host helpers re-derive those paths from the *recorded*
 * index — so the index must be settled before the paths are built. Allocating
 * with an unlocked `readState` and bumping a clash at record time would desync
 * the recorded index from the box's actual directory (status/ctl reads would
 * then miss it). Reserving up front, under the lock, guarantees the index a
 * create uses for its dirs is exactly the one in state.json, with no two
 * concurrent creates in the same project claiming the same number.
 */
export async function reserveProjectIndex(
  record: BoxRecord,
  projectRoot: string,
  path: string = STATE_FILE,
): Promise<number> {
  let index = 1;
  await mutateState((state) => {
    index = allocateProjectIndex(state, projectRoot);
    const reserved: BoxRecord = { ...record, projectRoot, projectIndex: index };
    return {
      version: 1,
      boxes: [...state.boxes.filter((b) => b.id !== record.id), reserved],
    };
  }, path);
  return index;
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
    portlessVncAlias: box.portlessVncAlias,
    portlessVncUrl: box.portlessVncUrl,
    dockerVolume: box.dockerVolume,
    dockerCacheShared: box.dockerCacheShared,
    checkpointImage: box.checkpointImage,
  };
}

export async function removeBoxRecord(id: string, path: string = STATE_FILE): Promise<boolean> {
  let removed = false;
  await mutateState((state) => {
    const next = state.boxes.filter((b) => b.id !== id);
    removed = next.length !== state.boxes.length;
    return { version: 1, boxes: next };
  }, path);
  return removed;
}

/**
 * Resolve a user-supplied identifier against the state file. Matching
 * precedence mirrors `docker`'s container reference resolution:
 *
 *   1. exact id
 *   2. unique id prefix
 *   3. exact name
 *   4. exact displayName (cosmetic label)
 *   5. exact container name
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

  // A renamed box is addressable by its cosmetic `displayName`. Lowest-precedence
  // exact match (after id/name) so a label that happens to equal another box's
  // id/name never shadows it; first match wins on displayName collisions.
  const byDisplayName = state.boxes.find((b) => b.displayName === q);
  if (byDisplayName) return { kind: 'ok', box: byDisplayName };

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
    const hit = state.boxes.find((b) => b.projectRoot === projectRoot && b.projectIndex === idx);
    return hit ? { kind: 'ok', box: hit } : { kind: 'none' };
  }
  return findBox(trimmed, state);
}
