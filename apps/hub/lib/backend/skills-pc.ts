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
  | { kind: 'unreachable'; detail?: string };

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

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
      const r = await run(machine, 'pcskills.inventory', {});
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
          status: c.status,
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
        outOfSync: rows.filter((x) => x.status !== 'same').length,
      };
    },

    async pullSkills(machineId, names, opts = {}) {
      const machine = machineOrThrow(machineId);
      const store = storeOrThrow(deps);
      const max = deps.maxTarballBytes?.();
      const out: PullResult[] = [];
      const changed: string[] = [];
      for (const name of names) {
        if (!NAME_RE.test(name)) {
          out.push({ name, status: 'failed', reason: 'invalid skill name' });
          continue;
        }
        const r = await run(machine, 'pcskills.export', {
          name,
          ...(opts.allowFindings ? { allowFindings: true } : {}),
        });
        if (r.kind !== 'result' || r.exitCode !== 0) {
          out.push({ name, status: 'failed', reason: reachError(r, machine.label) });
          continue;
        }
        try {
          const got = JSON.parse(r.stdout) as {
            version: string;
            description: string;
            size: number;
            files: number;
            path: string;
            tarball: string;
          };
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
      for (const name of names) {
        if (!NAME_RE.test(name)) {
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
        const r = await run(machine, 'pcskills.install', {
          name,
          version,
          tarball: tarball.toString('base64'),
          ...(opts.overwrite ? { overwrite: true } : {}),
        });
        if (r.kind !== 'result' || r.exitCode !== 0) {
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
