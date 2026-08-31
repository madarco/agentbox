/**
 * Tunnels for the exposed hub — the only way a *cloud* box can reach a control
 * box that binds loopback/LAN (a box polls the hub URL for registration,
 * approvals and git-lease, and `http://127.0.0.1:8787` is not reachable from a
 * Firecracker microVM). Opt-in: `agentbox hub expose --tunnel <kind>`.
 *
 * Two kinds:
 *  - cloudflare: a `cloudflared` quick tunnel — zero account, an EPHEMERAL
 *    `https://<rand>.trycloudflare.com` hostname scraped from its log. A
 *    `--tunnel-token` switches to a named tunnel with a stable hostname.
 *  - tailscale: `tailscale funnel` — a stable `https://<node>.<tailnet>.ts.net`;
 *    needs an authed tailscale daemon and HTTPS enabled on the tailnet.
 *
 * The tunnel runs as a detached process beside the hub (pid/log under the
 * control-plane dir) so `hub stop`/`destroy` reap it and autostart brings it
 * back. The URL-scrape is a pure function so it's unit-testable.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, openSync } from 'node:fs';
import { homedir, tmpdir, arch as osArch, platform } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execa } from 'execa';

export type TunnelKind = 'cloudflare' | 'tailscale';

const CP_DIR = join(homedir(), '.agentbox', 'control-plane');
const TUNNEL_PID_FILE = join(CP_DIR, 'tunnel.pid');
const TUNNEL_LOG_FILE = join(CP_DIR, 'tunnel.log');
const BIN_DIR = join(homedir(), '.agentbox', 'bin');

export interface TunnelHandle {
  kind: TunnelKind;
  publicUrl: string;
  pid: number | null;
  logFile: string;
}

export interface StartTunnelOptions {
  kind: TunnelKind;
  /** The local hub port to expose. */
  port: number;
  /** Named Cloudflare tunnel token (stable hostname) instead of a quick tunnel. */
  token?: string;
  onLog?: (line: string) => void;
  /** Seconds to wait for the tunnel URL to appear before giving up. */
  timeoutMs?: number;
}

/**
 * Extract a quick-tunnel hostname from cloudflared's log output. cloudflared
 * prints a boxed banner containing the URL to stderr; we just need the first
 * `https://<sub>.trycloudflare.com`. Pure — unit-tested.
 */
export function parseTrycloudflareUrl(logText: string): string | null {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(logText);
  return m ? m[0] : null;
}

/** Map node's os/arch to cloudflared's release asset naming. */
export function cloudflaredAsset(
  osName: string = platform(),
  arch: string = osArch(),
): { file: string; isTgz: boolean } {
  const a = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : arch;
  if (osName === 'darwin') return { file: `cloudflared-darwin-${a}.tgz`, isTgz: true };
  // linux ships a raw binary (also for the box's amd64/arm64).
  return { file: `cloudflared-linux-${a}`, isTgz: false };
}

async function onPath(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execa('command', ['-v', cmd], { shell: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a `cloudflared` binary: a system one on PATH, a previously-downloaded
 * copy, else download from GitHub releases (TLS-authenticated; the `latest`
 * download can't be checksum-pinned without knowing the version, so we rely on
 * HTTPS). Returns the executable path.
 */
export async function ensureCloudflared(onLog: (l: string) => void = () => {}): Promise<string> {
  const sys = await onPath('cloudflared');
  if (sys) return sys;
  const cached = join(BIN_DIR, 'cloudflared');
  if (existsSync(cached)) return cached;

  const { file, isTgz } = cloudflaredAsset();
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${file}`;
  await mkdir(BIN_DIR, { recursive: true });
  onLog(`downloading cloudflared (${file})…`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(
      `could not download cloudflared from ${url} (HTTP ${String(res.status)}). ` +
        'Install it manually (e.g. `brew install cloudflared`) and re-run.',
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (isTgz) {
    const tmp = join(tmpdir(), `cloudflared-${String(process.pid)}.tgz`);
    await writeFile(tmp, buf);
    // macOS ships the binary inside a .tgz; extract just `cloudflared`.
    await execa('tar', ['xzf', tmp, '-C', BIN_DIR, 'cloudflared']);
    await rm(tmp, { force: true });
  } else {
    await writeFile(cached, buf);
  }
  await chmod(cached, 0o755);
  return cached;
}

/** Spawn cloudflared detached, scrape its URL, and record the pid. */
async function startCloudflare(opts: StartTunnelOptions): Promise<TunnelHandle> {
  const log = opts.onLog ?? (() => {});
  const bin = await ensureCloudflared(log);
  await mkdir(CP_DIR, { recursive: true });
  // Fresh log so the URL scrape can't read a stale run's hostname.
  await writeFile(TUNNEL_LOG_FILE, '');
  const args = opts.token
    ? ['tunnel', '--no-autoupdate', 'run', '--token', opts.token]
    : // http2, not the default QUIC — UDP/7844 out of a nested/NAT'd box is unreliable.
      [
        'tunnel',
        '--no-autoupdate',
        '--protocol',
        'http2',
        '--url',
        `http://127.0.0.1:${String(opts.port)}`,
      ];
  const fd = openSync(TUNNEL_LOG_FILE, 'a');
  const child = spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  if (typeof child.pid === 'number') await writeFile(TUNNEL_PID_FILE, String(child.pid));
  log(`spawned cloudflared (pid ${String(child.pid ?? '?')})`);

  // A named tunnel's hostname is not in the log — the caller supplies it via
  // --public-url; a quick tunnel prints its trycloudflare URL, which we scrape.
  if (opts.token) {
    return { kind: 'cloudflare', publicUrl: '', pid: child.pid ?? null, logFile: TUNNEL_LOG_FILE };
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const url = parseTrycloudflareUrl(await readFile(TUNNEL_LOG_FILE, 'utf8').catch(() => ''));
    if (url) {
      log(`tunnel URL: ${url}`);
      return {
        kind: 'cloudflare',
        publicUrl: url,
        pid: child.pid ?? null,
        logFile: TUNNEL_LOG_FILE,
      };
    }
    await delay(500);
  }
  await stopTunnel().catch(() => {});
  throw new Error(
    `cloudflared did not report a tunnel URL within ${String((opts.timeoutMs ?? 30_000) / 1000)}s — see ${TUNNEL_LOG_FILE}`,
  );
}

/** Turn on a tailscale funnel and resolve the node's public HTTPS name. */
async function startTailscale(opts: StartTunnelOptions): Promise<TunnelHandle> {
  const log = opts.onLog ?? (() => {});
  const ts = (await onPath('tailscale')) ?? 'tailscale';
  if (!(await onPath('tailscale'))) {
    throw new Error(
      'tailscale is not installed — install it and `tailscale up` first, then re-run.',
    );
  }
  // Funnel the port on 443 (background). Best-effort: a tailnet without HTTPS /
  // Funnel enabled errors here with an actionable message from tailscale itself.
  log('enabling tailscale funnel…');
  await execa(ts, ['funnel', '--bg', '--https=443', String(opts.port)]).catch((e: unknown) => {
    throw new Error(
      `tailscale funnel failed: ${e instanceof Error ? e.message : String(e)}. ` +
        'Enable HTTPS + Funnel for your tailnet in the admin console.',
    );
  });
  const { stdout } = await execa(ts, ['status', '--json']);
  const status = JSON.parse(stdout) as { Self?: { DNSName?: string } };
  const dns = (status.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!dns)
    throw new Error("could not resolve this node's tailscale DNS name from `tailscale status`.");
  const url = `https://${dns}`;
  log(`tunnel URL: ${url}`);
  // The funnel is served by the tailscaled daemon, not a child we own — record
  // no pid; teardown runs `tailscale funnel <port> off`.
  await writeFile(TUNNEL_PID_FILE, JSON.stringify({ tailscalePort: opts.port })).catch(() => {});
  return { kind: 'tailscale', publicUrl: url, pid: null, logFile: TUNNEL_LOG_FILE };
}

export async function startTunnel(opts: StartTunnelOptions): Promise<TunnelHandle> {
  return opts.kind === 'tailscale' ? startTailscale(opts) : startCloudflare(opts);
}

/** Stop whatever tunnel is recorded and clear its state. Idempotent. */
export async function stopTunnel(): Promise<void> {
  let raw = '';
  try {
    raw = await readFile(TUNNEL_PID_FILE, 'utf8');
  } catch {
    return; // no tunnel recorded
  }
  // A tailscale funnel is a daemon setting, not a child pid — turn it off.
  const asTs = safeJson(raw) as { tailscalePort?: number } | null;
  if (asTs && typeof asTs.tailscalePort === 'number') {
    const ts = (await onPath('tailscale')) ?? 'tailscale';
    await execa(ts, ['funnel', String(asTs.tailscalePort), 'off']).catch(() => {});
  } else {
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  await rm(TUNNEL_PID_FILE, { force: true });
}

/** True when a tunnel pid file exists (used by status). */
export function tunnelStateFile(): string {
  return TUNNEL_PID_FILE;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
