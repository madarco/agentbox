import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { createConnection } from 'node:net';
import { DEFAULT_LOG_DIR, DEFAULT_SOCKET_PATH } from '../types.js';

/**
 * `agentbox-ctl bootstrap` — the single, idempotent in-box self-configure step
 * every provider's box runs at bring-up. It replaces the host driving create
 * via several separate `backend.exec` calls (dockerd, the ctl daemon, VNC):
 * the host (or, in future, a serverless plane / cloud IDE) now just provisions
 * the sandbox and kicks ONE `agentbox-ctl bootstrap`, which:
 *
 *   1. optionally clones the workspace from a leased, token-bearing URL
 *      (`AGENTBOX_CLONE_URL`), scrubbing the remote back to the bare origin;
 *   2. starts dockerd (unless disabled), the ctl supervisor daemon, and the VNC
 *      stack — each only if it isn't already live.
 *
 * Idempotency is load-bearing: the same command serves create AND resume, and
 * Vercel's persistent snapshots keep daemons alive across resume — re-launching
 * blindly would spawn duplicates fighting over the socket/port. Each daemon is
 * probed first and only (re)launched when dead.
 *
 * Ordering matches the previous host-driven create sequence: dockerd-ready →
 * ctl daemon → VNC. dockerd/VNC are best-effort (a failure logs and continues);
 * a ctl-daemon failure is fatal (non-zero exit) so create surfaces it.
 */

export interface BootstrapEnv {
  AGENTBOX_CLONE_URL?: string;
  AGENTBOX_ORIGIN_URL?: string;
  AGENTBOX_CLONE_BRANCH?: string;
  AGENTBOX_CLONE_DEPTH?: string;
  /** '0' disables dockerd (Vercel can't run nested containers). Default: launch. */
  AGENTBOX_LAUNCH_DOCKERD?: string;
  /** '0' disables the VNC stack. Default: launch. */
  AGENTBOX_VNC_ENABLED?: string;
  AGENTBOX_VNC_PASSWORD?: string;
}

const WORKSPACE_DIR = '/workspace';
const DOCKER_SOCK = '/var/run/docker.sock';
const VNC_WEBSOCKIFY_PORT = 6080;

type Logger = (line: string) => void;

/**
 * Dependencies the orchestrator calls out to. Injected so the idempotency logic
 * (probe → skip-if-live / launch-if-dead) is unit-testable without real
 * processes or sockets.
 */
export interface BootstrapDeps {
  isCtlDaemonLive(): Promise<boolean>;
  isDockerdLive(): Promise<boolean>;
  isVncLive(): Promise<boolean>;
  /** Clone /workspace from the authed URL + scrub the remote. */
  cloneWorkspace(args: {
    cloneUrl: string;
    originUrl: string;
    branch?: string;
    depth?: string;
  }): Promise<void>;
  /** Is /workspace already a populated git repo (host-seeded)? */
  isWorkspacePopulated(): Promise<boolean>;
  ensureRuntimeDirs(): Promise<void>;
  launchDockerd(): Promise<void>;
  waitDockerdReady(timeoutMs: number): Promise<boolean>;
  launchCtlDaemon(): void;
  waitCtlDaemonReady(timeoutMs: number): Promise<boolean>;
  launchVnc(password: string): Promise<void>;
  log: Logger;
}

export interface BootstrapResult {
  cloned: boolean;
  dockerd: 'up' | 'skipped' | 'disabled' | 'failed';
  ctl: 'up' | 'already' | 'failed';
  vnc: 'up' | 'skipped' | 'disabled' | 'failed';
}

/**
 * Provider-agnostic orchestration. Returns a structured result; the caller maps
 * a failed ctl daemon to a non-zero process exit.
 */
export async function runBootstrap(env: BootstrapEnv, deps: BootstrapDeps): Promise<BootstrapResult> {
  await deps.ensureRuntimeDirs();

  // 1. Optional in-box clone. AGENTBOX_CLONE_URL is already token-bearing
  // (leased by the creator); we clone with it then scrub origin back to the
  // bare URL. Skipped when /workspace is already populated (laptop host-seed).
  let cloned = false;
  if (env.AGENTBOX_CLONE_URL && env.AGENTBOX_ORIGIN_URL) {
    if (await deps.isWorkspacePopulated()) {
      deps.log('workspace already populated; skipping in-box clone');
    } else {
      deps.log(`cloning workspace from origin${env.AGENTBOX_CLONE_BRANCH ? ` @${env.AGENTBOX_CLONE_BRANCH}` : ''}`);
      await deps.cloneWorkspace({
        cloneUrl: env.AGENTBOX_CLONE_URL,
        originUrl: env.AGENTBOX_ORIGIN_URL,
        branch: env.AGENTBOX_CLONE_BRANCH,
        depth: env.AGENTBOX_CLONE_DEPTH,
      });
      cloned = true;
    }
  }

  // 2. dockerd (best-effort). Default-on; Vercel sets AGENTBOX_LAUNCH_DOCKERD=0.
  let dockerd: BootstrapResult['dockerd'];
  if (env.AGENTBOX_LAUNCH_DOCKERD === '0') {
    dockerd = 'disabled';
  } else if (await deps.isDockerdLive()) {
    deps.log('dockerd already running; skipping');
    dockerd = 'skipped';
  } else {
    deps.log('launching dockerd');
    try {
      await deps.launchDockerd();
      dockerd = (await deps.waitDockerdReady(60_000)) ? 'up' : 'failed';
      if (dockerd === 'failed') deps.log('dockerd did not become ready (continuing)');
    } catch (err) {
      deps.log(`dockerd launch failed (continuing): ${errMsg(err)}`);
      dockerd = 'failed';
    }
  }

  // 3. ctl supervisor daemon (fatal on failure). Idempotent: skip when the
  // socket is already live (resume / re-kick / Vercel persistent snapshot).
  let ctl: BootstrapResult['ctl'];
  if (await deps.isCtlDaemonLive()) {
    deps.log('ctl daemon already running; skipping');
    ctl = 'already';
  } else {
    deps.log('launching ctl daemon');
    deps.launchCtlDaemon();
    ctl = (await deps.waitCtlDaemonReady(10_000)) ? 'up' : 'failed';
  }

  // 4. VNC (best-effort). Default-on; disabled via AGENTBOX_VNC_ENABLED=0.
  let vnc: BootstrapResult['vnc'];
  if (env.AGENTBOX_VNC_ENABLED === '0' || !env.AGENTBOX_VNC_PASSWORD) {
    vnc = 'disabled';
  } else if (await deps.isVncLive()) {
    deps.log('VNC already running; skipping');
    vnc = 'skipped';
  } else {
    deps.log('launching VNC stack');
    try {
      await deps.launchVnc(env.AGENTBOX_VNC_PASSWORD);
      vnc = 'up';
    } catch (err) {
      deps.log(`VNC launch failed (continuing): ${errMsg(err)}`);
      vnc = 'failed';
    }
  }

  return { cloned, dockerd, ctl, vnc };
}

// --- real (in-box) dependency implementations ---

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Connect to a unix socket without the daemon-revive side-effect in client.ts. */
function isUnixSocketLive(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(path);
    const done = (live: boolean) => {
      sock.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

function isTcpPortLive(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (live: boolean) => {
      sock.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/** Run a command to completion, returning its exit code (126 on spawn error). */
function run(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => {
      if (code !== 0 && stderr) process.stderr.write(stderr);
      resolve(code ?? 1);
    });
    child.on('error', () => resolve(126));
  });
}

/** Spawn a long-lived daemon detached, with stdout/stderr appended to logFile. */
function spawnDetached(cmd: string, args: string[], logFile: string): void {
  const fd = openSync(logFile, 'a');
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  // A missing binary surfaces as an async 'error' event; unhandled it crashes
  // the whole bootstrap. These daemons are best-effort (a slim base image may
  // not ship the VNC/dockerd scripts) — log and continue.
  child.on('error', (err) => {
    process.stderr.write(`agentbox-ctl bootstrap: ${cmd} failed to spawn: ${err.message}\n`);
  });
  child.unref();
}

async function hasSudo(): Promise<boolean> {
  return (await run('sh', ['-c', 'command -v sudo >/dev/null 2>&1'])) === 0;
}

function realDeps(log: Logger): BootstrapDeps {
  const ctlLog = `${DEFAULT_LOG_DIR}/ctl-daemon.log`;
  const dockerdLog = `${DEFAULT_LOG_DIR}/dockerd.log`;
  const vncLog = `${DEFAULT_LOG_DIR}/vnc-start.log`;
  return {
    isCtlDaemonLive: () => isUnixSocketLive(DEFAULT_SOCKET_PATH),
    isDockerdLive: async () =>
      (await run('docker', ['-H', `unix://${DOCKER_SOCK}`, 'info'])) === 0,
    isVncLive: () => isTcpPortLive('127.0.0.1', VNC_WEBSOCKIFY_PORT),
    isWorkspacePopulated: async () =>
      (await run('git', ['-C', WORKSPACE_DIR, 'rev-parse', '--is-inside-work-tree'])) === 0,
    cloneWorkspace: (args) => cloneWorkspace({ ...args, workspaceDir: WORKSPACE_DIR }),
    ensureRuntimeDirs: async () => {
      const sudo = (await hasSudo()) ? 'sudo -n ' : '';
      await run('sh', [
        '-c',
        `${sudo}mkdir -p /run/agentbox ${DEFAULT_LOG_DIR} && ${sudo}chown "$(id -un):$(id -gn)" /run/agentbox ${DEFAULT_LOG_DIR}`,
      ]);
    },
    launchDockerd: async () => {
      const dockerdStart = '/usr/local/bin/agentbox-dockerd-start';
      if (await hasSudo()) spawnDetached('sudo', ['-n', dockerdStart], dockerdLog);
      else spawnDetached(dockerdStart, [], dockerdLog);
    },
    waitDockerdReady: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await run('docker', ['-H', `unix://${DOCKER_SOCK}`, 'info'])) === 0) return true;
        await delay(500);
      }
      return false;
    },
    launchCtlDaemon: () => spawnDetached('/usr/local/bin/agentbox-ctl', ['daemon'], ctlLog),
    waitCtlDaemonReady: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await isUnixSocketLive(DEFAULT_SOCKET_PATH)) return true;
        await delay(200);
      }
      return false;
    },
    launchVnc: async (password) => {
      // agentbox-vnc-start reads AGENTBOX_VNC_PASSWORD from env and is itself
      // idempotent; we pass it through the detached child's inherited env.
      const prev = process.env.AGENTBOX_VNC_PASSWORD;
      process.env.AGENTBOX_VNC_PASSWORD = password;
      try {
        spawnDetached('/usr/local/bin/agentbox-vnc-start', [], vncLog);
      } finally {
        if (prev === undefined) delete process.env.AGENTBOX_VNC_PASSWORD;
        else process.env.AGENTBOX_VNC_PASSWORD = prev;
      }
      // Best-effort readiness: give websockify a moment to bind 6080.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await isTcpPortLive('127.0.0.1', VNC_WEBSOCKIFY_PORT)) return;
        await delay(200);
      }
    },
    log,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Clone /workspace from a token-bearing URL, then reset origin to the bare URL
 * so the leased token never persists in the box's git config. Exported for unit
 * testing against a local bare repo.
 */
export async function cloneWorkspace(args: {
  cloneUrl: string;
  originUrl: string;
  branch?: string;
  depth?: string;
  workspaceDir: string;
}): Promise<void> {
  const cloneArgs = ['clone'];
  if (args.depth) cloneArgs.push('--depth', args.depth);
  if (args.branch) cloneArgs.push('--branch', args.branch);
  cloneArgs.push(args.cloneUrl, args.workspaceDir);
  const code = await run('git', cloneArgs);
  if (code !== 0) throw new Error(`git clone failed (exit ${String(code)})`);
  // Scrub the token: leave origin pointing at the bare URL.
  await run('git', ['-C', args.workspaceDir, 'remote', 'set-url', 'origin', args.originUrl]);
}

export const bootstrapCommand = new Command('bootstrap')
  .description('Idempotent in-box self-configure: optional clone + launch dockerd/ctl/VNC')
  .action(async () => {
    const log: Logger = (line) => process.stdout.write(`agentbox-ctl bootstrap: ${line}\n`);
    const result = await runBootstrap(process.env as BootstrapEnv, realDeps(log));
    log(
      `done — clone=${String(result.cloned)} dockerd=${result.dockerd} ctl=${result.ctl} vnc=${result.vnc}`,
    );
    // Only a failed ctl daemon is fatal; dockerd/VNC are best-effort.
    process.exit(result.ctl === 'failed' ? 1 : 0);
  });
