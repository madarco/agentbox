import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

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
 * The create is `wx` (O_EXCL), so two processes racing on a fresh home agree:
 * the loser's write fails with EEXIST and it reads the winner's id. A file that
 * exists but does not hold an id (truncated by a crash between create and
 * write) is the only case that is overwritten — nothing can be keyed on it yet.
 */
export function getMachineId(): string {
  const file = machineIdFile();
  const cached = cache.get(file);
  if (cached) return cached;
  let id = readId(file);
  if (!id) {
    mkdirSync(join(homedir(), '.agentbox'), { recursive: true });
    const fresh = randomUUID();
    try {
      writeFileSync(file, `${fresh}\n`, { flag: 'wx', mode: 0o600 });
      id = fresh;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      id = readId(file);
      if (!id) {
        writeFileSync(file, `${fresh}\n`, { mode: 0o600 });
        chmodSync(file, 0o600);
        id = fresh;
      }
    }
  }
  cache.set(file, id);
  return id;
}

/** The hostname, for display. Never compare it to decide identity — see {@link sameMachine}. */
export function getMachineLabel(): string {
  return hostname();
}

/** This machine as a {@link MachineRef}. */
export function thisMachine(): Required<MachineRef> {
  return { id: getMachineId(), label: getMachineLabel() };
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
      ([, v]) => typeof v === 'object' && v !== null && (v as { label?: unknown }).label === m.label,
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
