/**
 * `SshTunnelManager` — one persistent `ssh` ControlMaster per box, plus dynamic
 * `-L` port forwards minted on demand. Shared by every SSH-reached provider
 * (hetzner, digitalocean, remote-docker).
 *
 * This is the load-bearing piece that makes those providers' preview-URL +
 * exec/file-I/O paths work without paying the SSH handshake on every call.
 *
 * Layout:
 *
 *   ~/.agentbox/[<namespace>/]boxes/<box-id>/ssh/
 *     id_ed25519        per-box private key (VPS providers only; 0600)
 *     known_hosts       per-box host-key pinning (VPS providers only)
 *     control.sock      ssh ControlMaster socket (created at runtime, removed by `-O exit`)
 *
 * `namespace` exists because provider sandbox-ids are only unique *within* a
 * provider — a DigitalOcean droplet id and a Hetzner server id can collide as
 * bare integers.
 *
 * Lifecycle:
 *
 *   - open()      → spawn `ssh -fNT -M -S control.sock [-i key] <dest>` once per box.
 *   - forward()   → `ssh -O forward -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> -S control.sock dummy`.
 *                   Picks a free local port. Idempotent per (boxId, remotePort)
 *                   — returns the cached localPort on a repeated call.
 *   - unforward() → `ssh -O cancel -L …`.
 *   - refresh()   → tear down a dead master + every cached forward, reopen.
 *   - close()     → `ssh -O exit -S control.sock dummy`; removes the socket.
 *
 * Thread-safety: a single AgentBox process owns one manager per CLI invocation.
 * Concurrent `forward()` calls for the same (boxId, remotePort) race-resolve to
 * the same localPort because the cache is checked first and `ssh -O forward` is
 * idempotent on the SSH side.
 */

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

const HOST = '127.0.0.1';

export interface SshTunnelOpenOptions {
  boxId: string;
  /** Host, IP, or `~/.ssh/config` alias to connect to. */
  vpsHost: string;
  /** Remote user. Omit to let `~/.ssh/config` decide (remote-docker aliases). */
  vpsUser?: string;
  /** Absolute path to the private key. Omit to use the agent / ssh_config identities. */
  identity?: string;
  /** Non-default SSH port. */
  port?: number;
  /** Override the derived `~/.agentbox/[ns/]boxes/<box-id>/ssh/` (tests inject this). */
  boxSshDir?: string;
  /** Override the connect-timeout (default 10s — fast-fail on a dropped firewall rule). */
  connectTimeoutSeconds?: number;
}

export interface PortForward {
  localPort: number;
  remotePort: number;
}

interface BoxTunnel {
  controlPath: string;
  vpsHost: string;
  vpsUser?: string;
  identity?: string;
  port?: number;
  boxSshDir: string;
  // remotePort → localPort. Used so repeated `forward()` calls for the same
  // remote port return the same local port without re-asking sshd.
  forwards: Map<number, number>;
}

export class SshTunnelManager {
  private boxes = new Map<string, BoxTunnel>();

  /**
   * `namespace` scopes the on-disk ssh dir so sandbox-ids from different
   * providers can't collide (a droplet id and a server id are both integers).
   */
  constructor(private readonly namespace?: string) {}

  /**
   * Open the ControlMaster for `boxId`. Idempotent: if a master is already up
   * for this box (socket exists + responsive), no-op. Otherwise spawn a fresh
   * `ssh -fNT -M` and wait for the socket to appear.
   */
  async open(opts: SshTunnelOpenOptions): Promise<void> {
    const boxSshDir = opts.boxSshDir ?? defaultBoxSshDir(opts.boxId, this.namespace);
    await mkdir(boxSshDir, { recursive: true, mode: 0o700 });
    const controlPath = join(boxSshDir, 'control.sock');
    const knownHosts = join(boxSshDir, 'known_hosts');
    const tunnel: BoxTunnel = {
      controlPath,
      vpsHost: opts.vpsHost,
      vpsUser: opts.vpsUser,
      identity: opts.identity,
      port: opts.port,
      boxSshDir,
      forwards: new Map(),
    };

    // Reuse an existing live master if the socket already responds.
    if (existsSync(controlPath) && (await this.isAlive(controlPath))) {
      this.boxes.set(opts.boxId, tunnel);
      return;
    }
    // Stale socket from a prior crashed process — remove before re-opening.
    if (existsSync(controlPath)) {
      await rm(controlPath, { force: true });
    }

    const connectTimeout = opts.connectTimeoutSeconds ?? 10;
    const argv = ['-fNT', '-M', '-S', controlPath];
    // A provider that mints its own key pins the host key too. One that rides
    // the user's `~/.ssh/config` (remote-docker) must inherit BOTH — see
    // `sshOptArgs` in ./ssh-exec.ts.
    if (opts.identity) {
      argv.push(
        '-i',
        opts.identity,
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        `UserKnownHostsFile=${knownHosts}`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
      );
    }
    if (opts.port !== undefined) {
      argv.push('-o', `Port=${String(opts.port)}`);
    }
    argv.push(
      '-o',
      'BatchMode=yes',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      `ConnectTimeout=${String(connectTimeout)}`,
      opts.vpsUser ? `${opts.vpsUser}@${opts.vpsHost}` : opts.vpsHost,
    );
    const res = await execa('ssh', argv, { reject: false });
    if (res.exitCode !== 0 || !existsSync(controlPath)) {
      throw new Error(
        `ssh ControlMaster failed for ${opts.boxId} (exit ${String(res.exitCode)}): ${res.stderr || res.stdout || '(no output)'}`,
      );
    }
    this.boxes.set(opts.boxId, tunnel);
  }

  /**
   * Mint (or fetch the cached) `127.0.0.1:<localPort> → remote:127.0.0.1:<remotePort>`
   * forward. Returns the local port. Idempotent per (boxId, remotePort).
   *
   * The cached entry is only returned when the underlying ControlMaster is
   * still alive — without that check we'd happily hand back a localPort that
   * stopped listening when the master died (e.g. transient network blip, host
   * sleep/wake). When the master is dead we drop ALL cached forwards for this
   * box (they all share one tunnel) and re-mint from scratch.
   */
  async forward(boxId: string, remotePort: number): Promise<number> {
    const tunnel = this.getTunnelOrThrow(boxId);
    const cached = tunnel.forwards.get(remotePort);
    if (cached !== undefined && (await this.isAlive(tunnel.controlPath))) {
      return cached;
    }
    if (cached !== undefined) {
      // Master died — every cached local port stopped listening. Drop them all;
      // callers that still hold a stale `localPort` get a fresh one next call.
      tunnel.forwards.clear();
    }
    const localPort = await pickFreePort();
    const argv = [
      '-O',
      'forward',
      '-L',
      `${HOST}:${String(localPort)}:${HOST}:${String(remotePort)}`,
      '-S',
      tunnel.controlPath,
      'dummy', // the target host is ignored when -O is used, but argv needs one
    ];
    const res = await execa('ssh', argv, { reject: false });
    if (res.exitCode !== 0) {
      throw new Error(
        `ssh -O forward failed for ${boxId} (exit ${String(res.exitCode)}): ${res.stderr || res.stdout || '(no output)'}`,
      );
    }
    tunnel.forwards.set(remotePort, localPort);
    return localPort;
  }

  /**
   * Tear down a dead ControlMaster + every cached forward for this box, then
   * re-open from scratch. Idempotent. Returns when the master is open and the
   * box's forwards map is empty (ready for fresh forward() calls).
   *
   * Use case: the cloud-poller observes ECONNREFUSED on the local port and asks
   * the backend to refresh the preview URL — that path calls into here so the
   * master + forward both come back fresh.
   */
  async refresh(opts: SshTunnelOpenOptions): Promise<void> {
    const existing = this.boxes.get(opts.boxId);
    if (existing) {
      const alive = await this.isAlive(existing.controlPath);
      if (!alive && existsSync(existing.controlPath)) {
        // Stale socket from a dead master — best-effort cleanup, then reopen.
        try {
          await execa('ssh', ['-O', 'exit', '-S', existing.controlPath, 'dummy'], {
            reject: false,
          });
        } catch {
          // ignore — `-O exit` on a dead master can fail
        }
        await rm(existing.controlPath, { force: true });
      }
      // Either way drop the cached forwards: even if the master happened to be
      // alive, the caller asked us to refresh because *something* upstream (the
      // local port) wasn't responding.
      existing.forwards.clear();
    }
    await this.open(opts);
  }

  /** Tear down a single forward. Idempotent — unknown ports are no-ops. */
  async unforward(boxId: string, remotePort: number): Promise<void> {
    const tunnel = this.getTunnelOrThrow(boxId);
    const localPort = tunnel.forwards.get(remotePort);
    if (localPort === undefined) return;
    const argv = [
      '-O',
      'cancel',
      '-L',
      `${HOST}:${String(localPort)}:${HOST}:${String(remotePort)}`,
      '-S',
      tunnel.controlPath,
      'dummy',
    ];
    await execa('ssh', argv, { reject: false });
    tunnel.forwards.delete(remotePort);
  }

  /**
   * Close the ControlMaster (and all its forwards). Idempotent — if no master
   * is recorded, no-op. Removes the socket file.
   */
  async close(boxId: string): Promise<void> {
    const tunnel = this.boxes.get(boxId);
    if (!tunnel) return;
    if (existsSync(tunnel.controlPath)) {
      await execa('ssh', ['-O', 'exit', '-S', tunnel.controlPath, 'dummy'], { reject: false });
      await rm(tunnel.controlPath, { force: true });
    }
    this.boxes.delete(boxId);
  }

  /** Tear down every open box. */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.boxes.keys());
    await Promise.all(ids.map((id) => this.close(id)));
  }

  /** Path to the ControlMaster socket for `boxId`, if open. */
  controlPath(boxId: string): string | undefined {
    return this.boxes.get(boxId)?.controlPath;
  }

  /** True if a ControlMaster is registered for `boxId` (regardless of liveness). */
  has(boxId: string): boolean {
    return this.boxes.has(boxId);
  }

  /** Per-box ssh dir (tests use this to verify the layout). */
  boxSshDir(boxId: string): string | undefined {
    return this.boxes.get(boxId)?.boxSshDir;
  }

  /** Re-open the manager record for an existing-on-disk control socket. */
  registerExisting(boxId: string, opts: SshTunnelOpenOptions): void {
    const boxSshDir = opts.boxSshDir ?? defaultBoxSshDir(opts.boxId, this.namespace);
    this.boxes.set(boxId, {
      controlPath: join(boxSshDir, 'control.sock'),
      vpsHost: opts.vpsHost,
      vpsUser: opts.vpsUser,
      identity: opts.identity,
      port: opts.port,
      boxSshDir,
      forwards: new Map(),
    });
  }

  private async isAlive(controlPath: string): Promise<boolean> {
    const res = await execa('ssh', ['-O', 'check', '-S', controlPath, 'dummy'], { reject: false });
    return res.exitCode === 0;
  }

  private getTunnelOrThrow(boxId: string): BoxTunnel {
    const t = this.boxes.get(boxId);
    if (!t) throw new Error(`no SSH ControlMaster registered for box ${boxId}; call open() first`);
    return t;
  }
}

/**
 * Default per-box ssh dir: `~/.agentbox/[<namespace>/]boxes/<box-id>/ssh/`.
 *
 * `boxId` is sanitized because a provider may key its sandboxes by something
 * that isn't path-safe (remote-docker's sandbox-id embeds the SSH destination,
 * so it carries `@`, `:` and `/`).
 */
export function defaultBoxSshDir(boxId: string, namespace?: string): string {
  const safe = boxId.replace(/[^A-Za-z0-9._-]/g, '_');
  return namespace
    ? resolve(homedir(), '.agentbox', namespace, 'boxes', safe, 'ssh')
    : resolve(homedir(), '.agentbox', 'boxes', safe, 'ssh');
}

/**
 * Ask the kernel for a free port in the ephemeral range: bind a fresh server on
 * `127.0.0.1:0`, capture the port the kernel assigned, and close. There's a tiny
 * race where the port could be claimed before `ssh -O forward` lands, but in
 * practice ssh's idempotent socket re-creation doesn't conflict.
 */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolveOk, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not get a free local port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolveOk(port));
    });
  });
}
