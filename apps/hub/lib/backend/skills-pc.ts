// Hub <-> PC skills (docs/hub-settings-plan.md, Phase 2): the skills page's
// comparison of the hub's library with one PC's skill dirs, and the two moves
// between them, *Pull to Hub* and *Send to <machine>*.
//
// The PC answers for itself through its relay's `pcskills.*` host actions: the
// hub's own machine in-process, an enrolled device through host-reach routing.
// Nothing about a PC is stored here; every comparison asks it again. The
// comparison itself is the CLI TUI's (`compareSkills` in @agentbox/sandbox-core),
// so `agentbox skills` and this page agree on every row.
import { Readable } from 'node:stream';
import {
  agentSkillDirs,
  agentsForSkillDirs,
  compareSkills,
  readTar,
  skillDirOfPath,
  EXPOSED_HUB_ENV,
  SKILL_NAME_RE,
  treeHash,
  type AgentSkillDirs,
  type InstallOutcome,
  type PcSkill,
  type PcSkillsInventory,
} from '@agentbox/sandbox-core';
import {
  importSkill,
  listSkills,
  openSkillTarball,
  SkillsError,
  type SkillsStore,
  type SkillSummary,
} from './skills';

/** One machine a skills comparison can run against. */
export interface SkillMachine {
  id: string;
  label: string;
  /** The hub's own machine (served in-process). */
  self: boolean;
  online: boolean;
}

/** A PC's answer to one `pcskills.*` action, or why it gave none. */
export type PcReach =
  | { kind: 'result'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'unreachable'; detail?: string; timedOut?: boolean };

export interface PcSkillsBackendDeps {
  store(): SkillsStore | null;
  maxTarballBytes?(): number | undefined;
  /** The hub's own machine when it is a PC (null on a deployed control box). */
  self(): { id: string; label: string } | null;
  /** Enrolled, not revoked devices. Empty on a hub with no enrollment. */
  devices(): { id: string; label: string }[];
  /** Ids of devices whose relay is connected right now. */
  present(): string[];
  /** Run a `pcskills.*` action on the hub's own machine. */
  runSelf(method: string, params: unknown): Promise<PcReach>;
  /** Route a `pcskills.*` action to an enrolled device. Absent: no routing here. */
  runDevice?(deviceId: string, label: string, method: string, params: unknown): Promise<PcReach>;
  /** `current` moved for these skills: running boxes sync. */
  skillsChanged(names: string[]): void;
  /** Registry agents and their PC skill dirs (tests). */
  agentDirs?(): AgentSkillDirs[];
  /** Override {@link COMPARE_TIMEOUT_MS} (tests). */
  compareTimeoutMs?: number;
  /** Override {@link DEVICE_ACTION_TIMEOUT_MS} (tests). */
  deviceActionTimeoutMs?: number;
}

export type SkillRowStatus = 'same' | 'differs' | 'local-only' | 'hub-only' | 'unknown';

export interface SkillCompareRow {
  name: string;
  description: string;
  /** `unknown`: the PC could not be asked (offline or failed); only hub rows are listed. */
  status: SkillRowStatus;
  newer?: 'local' | 'hub';
  /** The agents whose PC skill dirs it came from. Information only. */
  agents: string[];
  /** Present when the hub holds it. */
  hub?: { current: string; updatedAt: string; pending: boolean };
  /** Present when the PC holds it. */
  pc?: {
    treeSha: string;
    dirs: string[];
    path: string;
    size: number;
    files: number;
    problems: string[];
    findings: { rule: string; path: string; line: number }[];
    conflicting?: boolean;
  };
}

export interface SkillCompare {
  machine: SkillMachine;
  /** Why the PC side is missing, when it is. */
  error?: string;
  rows: SkillCompareRow[];
  /** Rows not in sync (`differs`, `local-only`, `hub-only`). */
  outOfSync: number;
}

export type PullResult =
  | { name: string; status: 'imported' | 'unchanged' | 'held'; version: string }
  | { name: string; status: 'failed'; reason: string };

export type SendResult = InstallOutcome | { name: string; status: 'failed'; reason: string };

export interface PcSkillsBackend {
  skillMachines(): Promise<{ machines: SkillMachine[]; defaultId: string | null }>;
  compareMachineSkills(machineId: string): Promise<SkillCompare>;
  pullSkills(
    machineId: string,
    names: string[],
    opts?: { allowFindings?: boolean },
  ): Promise<PullResult[]>;
  sendSkills(
    machineId: string,
    names: string[],
    opts?: { overwrite?: boolean },
  ): Promise<SendResult[]>;
}

/**
 * Whether this hub process runs on a PC, so its own skill dirs are the owner's
 * and it is offered as a machine. Decided from the hub's own env, never from the
 * deploy record (that lives on the PC that ran `hub deploy`, not on the server):
 * a `localhost` hub is a PC; a password-profile hub is a PC only when `hub
 * expose` spawned it (`AGENTBOX_HUB_EXPOSED`). A deployed hetzner / vercel hub
 * is a server whose `/root` is nobody's skill dir.
 */
export function hubRunsOnPc(env: Record<string, string | undefined> = process.env): boolean {
  const profile = env.AGENTBOX_HUB_PROFILE ?? 'localhost';
  if (profile === 'localhost') return true;
  return env[EXPOSED_HUB_ENV] === '1';
}

/**
 * How long a comparison waits for a device. Once a device takes an action the
 * queue waits for it with no limit, and a device runs its actions in order, so
 * an inventory queued behind an unanswered confirm would hang the page.
 */
export const COMPARE_TIMEOUT_MS = 20_000;

/**
 * How long one pull or send waits for a device. The PC turns an unanswered
 * confirm into a no after two minutes (`PC_SKILLS_CONFIRM_TTL_MS` in the relay);
 * this is that plus room for the transfer, so a lost answer can't hold the page.
 */
export const DEVICE_ACTION_TIMEOUT_MS = 180_000;

function withTimeout(p: Promise<PcReach>, ms: number, detail: string): Promise<PcReach> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<PcReach>((done) => {
      timer = setTimeout(() => done({ kind: 'unreachable', detail, timedOut: true }), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function storeOrThrow(deps: PcSkillsBackendDeps): SkillsStore {
  const s = deps.store();
  if (!s) throw new SkillsError('invalid_request', 'custody is not enabled on this hub');
  return s;
}

/** The agents a hub skill came from, by the PC dir in its `source.path`. */
export function hubSkillAgents(s: SkillSummary, agents: readonly AgentSkillDirs[]): string[] {
  const path = s.source.path;
  if (!path) return [];
  const dir = skillDirOfPath(path, s.name, agents);
  return dir ? agentsForSkillDirs([dir], agents) : [];
}

function reachError(r: PcReach, label: string): string {
  if (r.kind === 'unreachable') return r.detail ?? `${label} is offline`;
  if (r.exitCode === 77) return r.stderr.trim() || `declined on ${label}`;
  return r.stderr.trim() || `failed on ${label} (exit ${String(r.exitCode)})`;
}

interface PcExport {
  version: string;
  description: string;
  size: number;
  files: number;
  path: string;
  tarball: string;
}

/**
 * A device's answer to `pcskills.export`, checked before anything of it is
 * stored: the library records its description, size and path as the skill's.
 */
export function parseExport(v: unknown, name: string): PcExport {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const bad = (what: string): never => {
    throw new Error(`the machine's answer for ${name} has no valid ${what}`);
  };
  if (o.name !== undefined && o.name !== name) bad('name');
  const version =
    typeof o.version === 'string' && /^[0-9a-f]{64}$/.test(o.version) ? o.version : bad('version');
  const description =
    typeof o.description === 'string' && o.description.length <= 1024
      ? o.description
      : bad('description');
  const size =
    typeof o.size === 'number' && Number.isSafeInteger(o.size) && o.size >= 0
      ? o.size
      : bad('size');
  const files =
    typeof o.files === 'number' && Number.isSafeInteger(o.files) && o.files >= 1
      ? o.files
      : bad('file count');
  const path =
    typeof o.path === 'string' &&
    o.path.length > 0 &&
    o.path.length <= 4096 &&
    !/[\0\n]/.test(o.path)
      ? o.path
      : bad('path');
  const tarball =
    typeof o.tarball === 'string' && o.tarball.length > 0 ? o.tarball : bad('tarball');
  return { version, description, size, files, path, tarball };
}

export function createPcSkillsBackend(deps: PcSkillsBackendDeps): PcSkillsBackend {
  const agentDirs = (): AgentSkillDirs[] => deps.agentDirs?.() ?? agentSkillDirs();

  const listMachines = (): SkillMachine[] => {
    const out: SkillMachine[] = [];
    const self = deps.self();
    if (self) out.push({ id: self.id, label: self.label, self: true, online: true });
    if (deps.runDevice) {
      const present = new Set(deps.present());
      for (const d of deps.devices()) {
        if (self && d.id === self.id) continue;
        out.push({ id: d.id, label: d.label, self: false, online: present.has(d.id) });
      }
    }
    return out;
  };

  const machineOrThrow = (id: string): SkillMachine => {
    const m = listMachines().find((x) => x.id === id);
    if (!m) throw new SkillsError('not_found', `no machine '${id}' on this hub`);
    return m;
  };

  const run = (m: SkillMachine, method: string, params: unknown): Promise<PcReach> => {
    if (m.self) return deps.runSelf(method, params);
    if (!m.online) return Promise.resolve({ kind: 'unreachable', detail: `${m.label} is offline` });
    return deps.runDevice!(m.id, m.label, method, params);
  };

  /** A pull or send of one skill, bounded on a device (a confirm waits there). */
  const act = (m: SkillMachine, method: string, params: unknown): Promise<PcReach> =>
    m.self
      ? run(m, method, params)
      : withTimeout(
          run(m, method, params),
          deps.deviceActionTimeoutMs ?? DEVICE_ACTION_TIMEOUT_MS,
          `no answer from ${m.label} in time (was the confirm there answered?)`,
        );

  /** After a device stops answering, the rest of a batch is not sent to it. */
  const gaveUp = (m: SkillMachine): string => `not tried: ${m.label} stopped answering`;

  return {
    skillMachines() {
      const machines = listMachines();
      const first = machines.find((m) => m.self) ?? machines.find((m) => m.online) ?? machines[0];
      return Promise.resolve({ machines, defaultId: first?.id ?? null });
    },

    async compareMachineSkills(machineId) {
      const machine = machineOrThrow(machineId);
      const listing = await listSkills(storeOrThrow(deps));
      const agents = agentDirs();
      const hubRow = (s: SkillSummary) => ({
        current: s.current,
        updatedAt: s.updatedAt,
        pending: s.pending !== undefined,
      });

      let pcSkills: PcSkill[] | null = null;
      let error: string | undefined;
      const r = await withTimeout(
        run(machine, 'pcskills.inventory', {}),
        deps.compareTimeoutMs ?? COMPARE_TIMEOUT_MS,
        `${machine.label} did not answer in time (a confirm may be waiting there)`,
      );
      if (r.kind === 'result' && r.exitCode === 0) {
        try {
          pcSkills = (JSON.parse(r.stdout) as PcSkillsInventory).skills;
        } catch {
          error = `${machine.label} answered with something that is not an inventory`;
        }
      } else {
        error = reachError(r, machine.label);
      }

      if (!pcSkills) {
        return {
          machine: { ...machine, online: machine.online && r.kind === 'result' },
          ...(error ? { error } : {}),
          rows: listing.skills.map((s) => ({
            name: s.name,
            description: s.description,
            status: 'unknown' as const,
            agents: hubSkillAgents(s, agents),
            hub: hubRow(s),
          })),
          outOfSync: 0,
        };
      }

      const rows = compareSkills(pcSkills, listing.skills).map((c): SkillCompareRow => {
        const pc = c.local;
        const hub = c.hub;
        return {
          name: c.name,
          description: hub?.description || pc?.description || '',
          // No tree hash: the PC couldn't read its copy (too big, unreadable).
          status: pc && pc.treeSha === '' ? 'unknown' : c.status,
          ...(c.newer ? { newer: c.newer } : {}),
          agents: pc ? pc.agents : hub ? hubSkillAgents(hub, agents) : [],
          ...(hub ? { hub: hubRow(hub) } : {}),
          ...(pc
            ? {
                pc: {
                  treeSha: pc.treeSha,
                  dirs: pc.dirs,
                  path: pc.path,
                  size: pc.size,
                  files: pc.files,
                  problems: pc.problems,
                  findings: pc.findings,
                  ...(pc.conflicting ? { conflicting: true } : {}),
                },
              }
            : {}),
        };
      });
      return {
        machine,
        rows,
        outOfSync: rows.filter((x) => x.status !== 'same' && x.status !== 'unknown').length,
      };
    },

    async pullSkills(machineId, names, opts = {}) {
      const machine = machineOrThrow(machineId);
      const store = storeOrThrow(deps);
      const max = deps.maxTarballBytes?.();
      const out: PullResult[] = [];
      const changed: string[] = [];
      let stalled = false;
      for (const name of names) {
        if (!SKILL_NAME_RE.test(name)) {
          out.push({ name, status: 'failed', reason: 'invalid skill name' });
          continue;
        }
        if (stalled) {
          out.push({ name, status: 'failed', reason: gaveUp(machine) });
          continue;
        }
        const r = await act(machine, 'pcskills.export', {
          name,
          ...(opts.allowFindings ? { allowFindings: true } : {}),
        });
        if (r.kind !== 'result' || r.exitCode !== 0) {
          if (r.kind === 'unreachable' && r.timedOut) stalled = true;
          out.push({ name, status: 'failed', reason: reachError(r, machine.label) });
          continue;
        }
        try {
          const got = parseExport(JSON.parse(r.stdout), name);
          const tar = Buffer.from(got.tarball, 'base64');
          // The PC names the version; the hub re-derives it, so the library never
          // stores a tree under an id it does not hash to.
          const sha = treeHash(readTar(tar, max !== undefined ? { maxBytes: max } : {}));
          if (sha !== got.version) {
            throw new Error(
              `files hash to ${sha.slice(0, 12)}, ${machine.label} said ${got.version.slice(0, 12)}`,
            );
          }
          const res = await importSkill(store, {
            name,
            meta: {
              sha256: got.version,
              description: got.description,
              size: got.size,
              files: got.files,
              source: { host: machine.label, machineId: machine.id, path: got.path },
            },
            body: Readable.from([tar]),
            ...(max !== undefined ? { maxBytes: max } : {}),
          });
          if (res.currentChanged) changed.push(name);
          out.push({
            name,
            status: res.held ? 'held' : res.changed ? 'imported' : 'unchanged',
            version: res.version,
          });
        } catch (err) {
          out.push({
            name,
            status: 'failed',
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (changed.length > 0) deps.skillsChanged(changed);
      return out;
    },

    async sendSkills(machineId, names, opts = {}) {
      const machine = machineOrThrow(machineId);
      const store = storeOrThrow(deps);
      const out: SendResult[] = [];
      let stalled = false;
      for (const name of names) {
        if (!SKILL_NAME_RE.test(name)) {
          out.push({ name, status: 'failed', reason: 'invalid skill name' });
          continue;
        }
        let tarball: Buffer;
        let version: string;
        try {
          const t = await openSkillTarball(store, name);
          const chunks: Buffer[] = [];
          for await (const c of t.data as AsyncIterable<Buffer>) chunks.push(c);
          tarball = Buffer.concat(chunks);
          version = t.version;
        } catch (err) {
          out.push({
            name,
            status: 'failed',
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (stalled) {
          out.push({ name, status: 'failed', reason: gaveUp(machine) });
          continue;
        }
        const r = await act(machine, 'pcskills.install', {
          name,
          version,
          tarball: tarball.toString('base64'),
          ...(opts.overwrite ? { overwrite: true } : {}),
        });
        if (r.kind !== 'result' || r.exitCode !== 0) {
          if (r.kind === 'unreachable' && r.timedOut) stalled = true;
          out.push({ name, status: 'failed', reason: reachError(r, machine.label) });
          continue;
        }
        try {
          out.push(JSON.parse(r.stdout) as InstallOutcome);
        } catch {
          out.push({
            name,
            status: 'failed',
            reason: `${machine.label} sent an unreadable answer`,
          });
        }
      }
      return out;
    },
  };
}
