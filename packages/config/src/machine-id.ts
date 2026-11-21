import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

function readId(file: string): string | undefined {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    return isMachineId(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This machine's id, minting it on first use.
 *
 * The id is written to a private temp file first and then hard-linked into
 * place: `link` fails with EEXIST when the file is already there, so two
 * processes racing on a fresh home agree on the winner's id, and nobody ever
 * reads a half-written file. A file that exists but holds no id (hand-edited,
 * or truncated by an older build) is replaced by rename, then re-read, so every
 * racer caches whatever ended up on disk.
 */
export function getMachineId(): string {
  const file = machineIdFile();
  const cached = cache.get(file);
  if (cached) return cached;
  let id = readId(file);
  if (!id) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${randomUUID()}\n`, { flag: 'wx', mode: 0o600 });
    try {
      linkSync(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!readId(file)) renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
    id = readId(file);
    if (!id) throw new Error(`could not mint a machine id at ${file}`);
  }
  cache.set(file, id);
  return id;
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
 * with no id (an older client) also finds an id-keyed entry labelled with its
 * hostname.
 */
export function machineKeyIn(
  hosts: Readonly<Record<string, unknown>>,
  me: MachineRef | string,
): string | undefined {
  const m = toMachineRef(me);
  if (m.id && Object.hasOwn(hosts, m.id)) return m.id;
  if (Object.hasOwn(hosts, m.label)) return m.label;
  // A caller with no id can only vouch for its hostname: let it find the entry
  // its machine has since re-keyed under an id and labelled with that name.
  if (!m.id) {
    return Object.entries(hosts).find(
      ([, v]) =>
        typeof v === 'object' && v !== null && (v as { label?: unknown }).label === m.label,
    )?.[0];
  }
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
