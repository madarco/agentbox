/**
 * The pty carrier for a hub-run manager: spawn a detached pty host, wait for it
 * to listen, and describe the registration it produced.
 *
 * Sibling of `manager.ts` rather than more of it — the tmux carrier is 2000
 * lines already, and the two share only the script builder and the exit file.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, open as openFile, rm } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ensurePtyDir,
  newPtyRunId,
  newPtyToken,
  ptyLogPath,
  ptySocketPath,
  readPtyMeta,
  removePtySession,
  scrubAgentSessionEnv,
  type PtySessionMeta,
} from '@agentbox/sandbox-core';
import { buildManagerShellScript, loginShell } from './manager.js';
import { ptyHostAlive } from './pty-client.js';
import { managerExitFile, resolveWorkspaceDir, workspaceDir } from './workspace-store.js';
import type { ManagerPtyAttach, ManagerRecord, ManagerRegistration } from './types.js';

/** Tunables the hub resolves from config and hands to the host. */
export interface PtyCarrierSettings {
  leaseGraceMs: number;
  scrollbackBytes: number;
  submitDelayMs: number;
  windowSize: 'latest' | 'smallest' | 'largest';
}

export const PTY_CARRIER_DEFAULTS: PtyCarrierSettings = {
  leaseGraceMs: 60_000,
  scrollbackBytes: 512 * 1024,
  submitDelayMs: 400,
  windowSize: 'latest',
};

export interface StartManagerPtyInput {
  wsId: string;
  manager: ManagerRecord;
  argv: string[];
  env?: NodeJS.ProcessEnv;
  hostname?: () => string;
  settings?: Partial<PtyCarrierSettings>;
  /** Injected in tests so a start never spawns a real agent. */
  spawnHost?: SpawnPtyHost;
  baseDir?: string;
}

export interface PtyHostSpawnSpec {
  entry: string;
  spec: Record<string, unknown>;
  logPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type SpawnPtyHost = (spawnSpec: PtyHostSpawnSpec) => Promise<{ pid?: number }>;

export class PtyCarrierUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PtyCarrierUnavailable';
  }
}

const READY_TIMEOUT_MS = 8_000;

/**
 * Where `dist/pty-host.js` is. The hub is bundled separately from the CLI and
 * ships no `node_modules`, so the host must be resolved from the CLI install
 * that can actually load node-pty: the entry the hub was spawned with first,
 * then this repo's build, then a copy beside the hub bundle.
 */
export async function resolvePtyHostEntry(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const candidates: string[] = [];
  const cliEntry = env['AGENTBOX_CLI_ENTRY'];
  if (cliEntry) candidates.push(join(dirname(cliEntry), 'pty-host.js'));
  // A `pnpm dev` hub has no AGENTBOX_CLI_ENTRY; walk to this repo's build.
  candidates.push(resolve(process.cwd(), 'apps/cli/dist/pty-host.js'));
  candidates.push(join(dirname(process.argv[1] ?? ''), 'pty-host.js'));
  for (const candidate of candidates) {
    if (candidate.endsWith('pty-host.js') && (await exists(candidate))) return candidate;
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The default spawner: detached, output to the session's log, and the spec
 * written into fd 3.
 *
 * A PIPE, not a file: the spec carries the session token and the agent's launch
 * script. argv would show both to `ps` (which is what the tmux carrier did with
 * the script), and a temp file would put the token on disk — where an inherited
 * file descriptor is also already positioned at EOF, so the child reads nothing.
 */
export const defaultSpawnPtyHost: SpawnPtyHost = async (spawnSpec) => {
  await mkdir(dirname(spawnSpec.logPath), { recursive: true });
  const log = await openFile(spawnSpec.logPath, 'a');
  try {
    const child = spawn(process.execPath, [spawnSpec.entry, '--spec-fd', '3'], {
      detached: true,
      cwd: spawnSpec.cwd,
      env: spawnSpec.env,
      stdio: ['ignore', log.fd, log.fd, 'pipe'],
    });
    const specPipe = child.stdio[3] as NodeJS.WritableStream | null;
    if (!specPipe) throw new Error('could not open the spec pipe to the pty host');
    specPipe.end(JSON.stringify(spawnSpec.spec));
    child.unref();
    return { ...(child.pid === undefined ? {} : { pid: child.pid }) };
  } finally {
    await log.close().catch(() => {});
  }
};

/**
 * Start a manager on a pty host on THIS machine. Nothing is persisted here: the
 * caller writes the returned registration through its record store, exactly as
 * the tmux carrier does.
 */
export async function startManagerPtySession(
  input: StartManagerPtyInput,
): Promise<ManagerRegistration> {
  const rec = input.manager;
  const entry = await resolvePtyHostEntry(input.env);
  if (!entry) throw new PtyCarrierUnavailable('no pty-host entry found for this install');

  const settings = { ...PTY_CARRIER_DEFAULTS, ...input.settings };
  const exit = managerExitFile(await dirForWorkspace(input.wsId), rec.id);
  await mkdir(dirname(exit), { recursive: true });
  // A stale exit code from the previous run would be reported as this run's.
  await rm(exit, { force: true }).catch(() => {});
  await ensurePtyDir(input.baseDir);
  // A crashed host can leave a socket and a meta behind; a live one is adopted
  // by the host itself (it refuses to steal the path), so only clear a dead one.
  const socket = ptySocketPath(rec.id, input.baseDir);
  if (!(await ptyHostAlive(socket))) await removePtySession(rec.id, input.baseDir);

  const runId = newPtyRunId();
  const script = buildManagerShellScript({
    argv: input.argv,
    env: {
      AGENTBOX_WORKSPACE: input.wsId,
      // Carries the id so the agent's own `agentbox` calls are attributed to
      // THIS record, and the run id so detection can PROVE it.
      AGENTBOX_MANAGER: rec.id,
      AGENTBOX_MANAGER_RUN: runId,
    },
    exitFile: exit,
  });
  const env = scrubAgentSessionEnv(input.env ?? process.env);
  const spec = {
    managerId: rec.id,
    workspaceId: input.wsId,
    agent: rec.agent,
    cwd: rec.cwd,
    shell: loginShell(env),
    script,
    env: plainEnv(env),
    token: newPtyToken(),
    runId,
    cols: 120,
    rows: 34,
    pinned: rec.pinned === true,
    leaseGraceMs: settings.leaseGraceMs,
    scrollbackBytes: settings.scrollbackBytes,
    windowSize: settings.windowSize,
    submitDelayMs: settings.submitDelayMs,
    ...(input.baseDir ? { baseDir: input.baseDir } : {}),
  };

  const spawnHost = input.spawnHost ?? defaultSpawnPtyHost;
  await spawnHost({
    entry,
    spec,
    logPath: ptyLogPath(rec.id, input.baseDir),
    cwd: rec.cwd,
    env,
  });

  const meta = await waitForHost(rec.id, input.baseDir);
  if (!meta) {
    throw new PtyCarrierUnavailable(
      `pty host did not come up; see ${ptyLogPath(rec.id, input.baseDir)}`,
    );
  }

  return {
    id: rec.id,
    agent: rec.agent,
    kind: 'pty',
    host: (input.hostname ?? osHostname)(),
    cwd: rec.cwd,
    pty: {
      pid: meta.pid,
      socket: meta.socket,
      runId: meta.runId,
    },
    argv: input.argv,
    ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
  };
}

/** Meta file written AND socket accepting: either alone is a half-started host. */
async function waitForHost(
  managerId: string,
  baseDir?: string,
): Promise<PtySessionMeta | undefined> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const meta = await readPtyMeta(managerId, baseDir);
    if (meta && (await ptyHostAlive(meta.socket))) return meta;
    await delay(100);
  }
  return undefined;
}

/** What a client runs to open this session's terminal. */
export function ptyAttachFor(
  rec: Pick<ManagerRecord, 'id' | 'pty'>,
  cliEntry: string | undefined,
  protocol: number,
): ManagerPtyAttach | undefined {
  if (!rec.pty) return undefined;
  const entry = cliEntry ?? process.env['AGENTBOX_CLI_ENTRY'];
  // Absolute argv: an embedding app (the tray) runs it under a shell with no
  // login PATH, so `agentbox` alone would not resolve.
  const command = entry
    ? [process.execPath, entry, 'manager', 'attach', rec.id, '--raw']
    : ['agentbox', 'manager', 'attach', rec.id, '--raw'];
  return { command, socket: rec.pty.socket, protocol };
}

function plainEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

async function dirForWorkspace(wsId: string): Promise<string> {
  return (await resolveWorkspaceDir(wsId)) ?? workspaceDir(wsId);
}
