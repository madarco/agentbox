import { randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * This machine's stable identity: a random UUID minted once into
 * `~/.agentbox/machine-id` and never regenerated.
 *
 * `os.hostname()` is not an identity. macOS derives it from `LocalHostName` and
 * auto-suffixes it (`-2`) on a Bonjour name collision, then flips it back, so a
 * record stamped with the hostname is orphaned whenever the network changes.
 * The hostname stays as the human label ({@link getMachineLabel}); every record
 * that has to answer "is this the machine it names?" keys on the id.
 *
 * A later device record (hub enrollment) references this id rather than
 * minting a second one.
 */
export interface MachineRef {
  /** `getMachineId()` of that machine. Absent on records and clients that predate it. */
  id?: string;
  /** Its hostname when last seen. Display only, plus the legacy match for id-less records. */
  label: string;
}

const MACHINE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `s` has the shape of a minted machine id (lowercase UUID). */
export function isMachineId(s: unknown): s is string {
  return typeof s === 'string' && MACHINE_ID_RE.test(s);
}

/** Path of the id file, resolved against the CURRENT `$HOME` so a test's temp home is honoured. */
export function machineIdFile(): string {
  return join(homedir(), '.agentbox', 'machine-id');
}

const cache = new Map<string, string>();

type IdState = { kind: 'id'; id: string } | { kind: 'missing' } | { kind: 'invalid' };

/**
 * What the id file holds. Only ENOENT counts as missing; any other read error
 * (EACCES on a file an elevated process minted, EIO) throws, so the caller can
 * never mistake an unreadable id for an absent one and overwrite it.
 */
function readState(file: string): IdState {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  return isMachineId(raw) ? { kind: 'id', id: raw } : { kind: 'invalid' };
}

function freshIdFile(file: string): string {
  const tmp = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${randomUUID()}\n`, { flag: 'wx', mode: 0o600 });
  return tmp;
}

/** Publishes a fresh id where none exists; `false` when another process got there first. */
function linkFresh(file: string): boolean {
  const tmp = freshIdFile(file);
  try {
    linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Replaces a file that holds no id, under a `mkdir` lock so concurrent
 * repairers converge: only the lock holder writes, and it re-reads under the
 * lock first, so a file someone else already repaired is never replaced. A
 * waiter re-reads until the holder is done. A lock older than
 * {@link LOCK_STALE_MS} is a crashed holder's and is taken over.
 */
function repairInvalid(file: string): void {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (readState(file).kind === 'id') return;
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released between our mkdir and stat
    }
    if (age > LOCK_STALE_MS) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
    sleepSync(25);
  }
  try {
    const state = readState(file);
    if (state.kind === 'invalid') renameSync(freshIdFile(file), file);
    else if (state.kind === 'missing') linkFresh(file);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * This machine's id, minting it on first use. An id already on disk is never
 * replaced.
 *
 * A fresh id is written to a private temp file and hard-linked into place:
 * `link` fails with EEXIST when the file is already there, so processes racing
 * on a fresh home agree on the winner's id and nobody reads a half-written file.
 * A file that exists but holds no id (hand-edited, or truncated by a crash) is
 * repaired under a lock ({@link repairInvalid}). A file that cannot be read
 * throws rather than being taken for missing.
 */
export function getMachineId(): string {
  const file = machineIdFile();
  const cached = cache.get(file);
  if (cached) return cached;
  let state = readState(file);
  if (state.kind !== 'id') {
    mkdirSync(dirname(file), { recursive: true });
    if (state.kind === 'missing') linkFresh(file);
    state = readState(file);
    if (state.kind === 'invalid') {
      repairInvalid(file);
      state = readState(file);
    }
    if (state.kind !== 'id') throw new Error(`could not mint a machine id at ${file}`);
  }
  cache.set(file, state.id);
  return state.id;
}

/**
 * {@link getMachineId}, or `undefined` when it cannot be read or minted (an
 * unwritable or read-only `$HOME`). For the read paths that used to call
 * `os.hostname()`, which never failed: they degrade to matching by hostname
 * rather than refusing to serve.
 */
export function tryGetMachineId(): string | undefined {
  try {
    return getMachineId();
  } catch {
    return undefined;
  }
}

/** The hostname, for display. Never compare it to decide identity — see {@link sameMachine}. */
export function getMachineLabel(): string {
  return hostname();
}

/** This machine as a {@link MachineRef}; `id` is absent only when it cannot be minted. */
export function thisMachine(): MachineRef {
  const id = tryGetMachineId();
  return { ...(id ? { id } : {}), label: getMachineLabel() };
}

/** A bare string is a hostname: that is all a legacy caller or record ever held. */
export function toMachineRef(m: MachineRef | string): MachineRef {
  return typeof m === 'string' ? { label: m } : m;
}

/**
 * Whether a record stamped `{ machineId, host }` names machine `me`.
 *
 * When both sides carry an id, the id decides alone: two machines may share a
 * hostname, and one machine's hostname flips. When either side predates the id,
 * the hostname is all there is — that fallback is what adopts an old record, and
 * the caller re-stamps it with the id once it matched.
 */
export function sameMachine(
  rec: { machineId?: string | undefined; host?: string | undefined },
  me: MachineRef | string,
): boolean {
  const m = toMachineRef(me);
  if (rec.machineId && m.id) return rec.machineId === m.id;
  return rec.host !== undefined && rec.host === m.label;
}

/**
 * The key a `hosts` map (workspace folder mappings) holds for machine `me`: its
 * id, else — for an entry written before the id existed — its hostname. A `me`
 * with no id never finds an id-keyed entry by its label: a hostname vouches for
 * nothing, and another machine may share it.
 */
export function machineKeyIn(
  hosts: Readonly<Record<string, unknown>>,
  me: MachineRef | string,
): string | undefined {
  const m = toMachineRef(me);
  if (m.id && Object.hasOwn(hosts, m.id)) return m.id;
  if (Object.hasOwn(hosts, m.label)) return m.label;
  return undefined;
}

/** The key a writer should store machine `me` under: the id when known. */
export function machineKeyFor(me: MachineRef | string): string {
  const m = toMachineRef(me);
  return m.id ?? m.label;
}

/** {@link sameMachine} for two refs (either may be a bare hostname). */
export function sameMachineRef(a: MachineRef | string, b: MachineRef | string): boolean {
  const x = toMachineRef(a);
  return sameMachine({ host: x.label, ...(x.id ? { machineId: x.id } : {}) }, b);
}
