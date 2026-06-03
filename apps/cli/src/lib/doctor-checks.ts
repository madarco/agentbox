/**
 * Shared compatibility/status checks consumed by `agentbox doctor` (full
 * detail) and `agentbox install` (compact one-line summary).
 *
 * All probes are local, read-only, and offline-safe — they never call out to
 * a cloud API. Remote snapshot inventory lives in `agentbox prepare --status`.
 */

import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface CheckGroup {
  /** Group title: 'system' | 'docker' | 'daytona' | 'hetzner' | 'vercel' | 'e2b'. */
  title: string;
  results: CheckResult[];
}

export type ProviderName = 'docker' | 'daytona' | 'hetzner' | 'vercel' | 'e2b';

const ALL_PROVIDERS: ProviderName[] = ['docker', 'daytona', 'hetzner', 'vercel', 'e2b'];
const NODE_MIN_MAJOR = 20;
const NODE_MIN_MINOR = 10;

async function probeVersion(bin: string, args: string[] = ['--version']): Promise<string | null> {
  try {
    const r = await execa(bin, args, { reject: false });
    if (r.exitCode !== 0) return null;
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
    return out.length > 0 ? out : bin;
  } catch {
    return null;
  }
}

function parseNodeMajorMinor(v: string): [number, number] {
  const m = /^v?(\d+)\.(\d+)/.exec(v);
  if (!m) return [0, 0];
  return [Number(m[1]), Number(m[2])];
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

function errSummary(err: unknown): string {
  return err instanceof Error ? firstLine(err.message) : String(err);
}

function checkNode(): CheckResult {
  const v = process.versions.node;
  const [maj, min] = parseNodeMajorMinor(v);
  const ok = maj > NODE_MIN_MAJOR || (maj === NODE_MIN_MAJOR && min >= NODE_MIN_MINOR);
  return {
    label: 'node',
    status: ok ? 'ok' : 'fail',
    detail: ok ? `v${v}` : `v${v} (need >=${String(NODE_MIN_MAJOR)}.${String(NODE_MIN_MINOR)})`,
    hint: ok ? undefined : 'upgrade Node before continuing',
  };
}

function checkPlatform(): CheckResult {
  const supported = process.platform === 'darwin' || process.platform === 'linux';
  return {
    label: 'platform',
    status: supported ? 'ok' : 'warn',
    detail: `${process.platform}/${process.arch}`,
    hint: supported ? undefined : 'agentbox supports macOS and Linux hosts; this OS is untested',
  };
}

function checkAgentboxHome(): CheckResult {
  const dir = join(homedir(), '.agentbox');
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, fsConstants.W_OK);
    return { label: '~/.agentbox', status: 'ok', detail: dir };
  } catch (err) {
    return {
      label: '~/.agentbox',
      status: 'fail',
      detail: `not writable: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'check directory permissions',
    };
  }
}

async function checkGit(): Promise<CheckResult> {
  const v = await probeVersion('git');
  return v
    ? { label: 'git', status: 'ok', detail: v }
    : {
        label: 'git',
        status: 'warn',
        detail: 'not found',
        hint: 'install git — required for the workspace git-bundle seed',
      };
}

async function checkSsh(): Promise<CheckResult> {
  // ssh -V prints to stderr; probeVersion concatenates both streams.
  const v = await probeVersion('ssh', ['-V']);
  return v
    ? { label: 'ssh', status: 'ok', detail: v }
    : {
        label: 'ssh',
        status: 'warn',
        detail: 'not found',
        hint: 'install ssh — required for hetzner and cloud attach',
      };
}

export async function runSystemChecks(): Promise<CheckResult[]> {
  const [git, ssh] = await Promise.all([checkGit(), checkSsh()]);
  return [checkNode(), checkPlatform(), checkAgentboxHome(), git, ssh];
}

async function dockerChecks(): Promise<CheckResult[]> {
  const linux = process.platform === 'linux';
  const cli = await probeVersion('docker');
  if (!cli) {
    return [
      {
        label: 'docker cli',
        status: 'warn',
        detail: 'not found',
        hint: linux
          ? 'install docker engine: https://docs.docker.com/engine/install/'
          : 'install Docker Desktop, OrbStack, or docker engine',
      },
    ];
  }
  const cliRes: CheckResult = { label: 'docker cli', status: 'ok', detail: cli };

  // Daemon reachability via `docker info` (same probe pattern as
  // packages/sandbox-docker/src/docker.ts:dockerInfo). On Linux the most common
  // failure is not a stopped daemon but the user missing from the `docker`
  // group — `docker info` then exits non-zero with "permission denied" on the
  // socket. Distinguish the two so the hint points at the right fix.
  const info = await execa('docker', ['info'], { reject: false });
  if (info.exitCode !== 0) {
    const permDenied = `${info.stderr ?? ''}`.toLowerCase().includes('permission denied');
    let hint: string;
    if (permDenied && linux) {
      hint =
        'add your user to the docker group: `sudo usermod -aG docker $USER`, then log out/in (or run `newgrp docker`)';
    } else if (linux) {
      hint = 'start Docker: `sudo systemctl start docker` (install docker engine if missing)';
    } else {
      hint = 'start Docker (Desktop / OrbStack)';
    }
    return [
      cliRes,
      {
        label: 'docker daemon',
        status: 'warn',
        detail: permDenied ? 'permission denied' : 'unreachable',
        hint,
      },
    ];
  }
  const daemonRes: CheckResult = { label: 'docker daemon', status: 'ok', detail: 'reachable' };

  // Probe the base image + shared volumes. Lazy-import to keep the docker
  // package off the hot path for non-docker users.
  const mod = await import('@agentbox/sandbox-docker');
  let imgRes: CheckResult;
  try {
    const img = await mod.imageInfo(mod.DEFAULT_BOX_IMAGE);
    imgRes = img.exists
      ? { label: 'box image', status: 'ok', detail: `${mod.DEFAULT_BOX_IMAGE} built` }
      : {
          label: 'box image',
          status: 'warn',
          detail: `${mod.DEFAULT_BOX_IMAGE} not built`,
          hint: 'run `agentbox prepare --provider docker` (or let the wizard do it)',
        };
  } catch (err) {
    imgRes = {
      label: 'box image',
      status: 'warn',
      detail: errSummary(err),
    };
  }

  const volNames = [mod.SHARED_CLAUDE_VOLUME, mod.SHARED_CODEX_VOLUME, mod.SHARED_OPENCODE_VOLUME];
  const vols = await Promise.all(
    volNames.map(async (n) => ({ name: n, exists: await mod.volumeExists(n).catch(() => false) })),
  );
  const present = vols.filter((v) => v.exists).length;
  const volRes: CheckResult = {
    label: 'shared volumes',
    status: 'ok',
    detail: `${String(present)}/${String(vols.length)} present (seeded lazily)`,
  };

  return [cliRes, daemonRes, imgRes, volRes];
}

async function daytonaChecks(): Promise<CheckResult[]> {
  try {
    const mod = await import('@agentbox/sandbox-daytona');
    const status = await mod.getDaytonaStatus();
    if (!status.configured) {
      return [
        {
          label: 'credentials',
          status: 'warn',
          detail: status.reason ?? 'not configured',
          hint: '`agentbox daytona login`',
        },
      ];
    }
    const credRes: CheckResult = { label: 'credentials', status: 'ok', detail: 'configured' };
    const snapRes: CheckResult =
      status.snapshots.length > 0
        ? {
            label: 'base snapshot',
            status: 'ok',
            detail: `${String(status.snapshots.length)} agentbox snapshot(s)`,
          }
        : {
            label: 'base snapshot',
            status: 'warn',
            detail: 'none',
            hint: '`agentbox prepare --provider daytona`',
          };
    return [credRes, snapRes];
  } catch (err) {
    return [
      {
        label: 'credentials',
        status: 'warn',
        detail: errSummary(err),
      },
    ];
  }
}

async function hetznerChecks(): Promise<CheckResult[]> {
  try {
    const mod = await import('@agentbox/sandbox-hetzner');
    const cred = mod.readHetznerCredStatus();
    const credRes: CheckResult =
      cred.source === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'HCLOUD_TOKEN not set',
            hint: '`agentbox hetzner login`',
          }
        : { label: 'credentials', status: 'ok', detail: `token from ${cred.source}` };

    const prepared = mod.readPreparedState();
    const snapRes: CheckResult = prepared.base?.imageId
      ? {
          label: 'base snapshot',
          status: 'ok',
          detail: `image ${String(prepared.base.imageId)} (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base snapshot',
          status: 'warn',
          detail: 'not baked',
          hint: '`agentbox prepare --provider hetzner`',
        };
    return [credRes, snapRes];
  } catch (err) {
    return [
      {
        label: 'credentials',
        status: 'warn',
        detail: errSummary(err),
      },
    ];
  }
}

async function vercelChecks(): Promise<CheckResult[]> {
  try {
    const mod = await import('@agentbox/sandbox-vercel');
    const cred = mod.readVercelCredStatus();
    const credRes: CheckResult =
      cred.auth === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'not configured',
            hint: '`agentbox vercel login`',
          }
        : {
            label: 'credentials',
            status: 'ok',
            detail: `${cred.auth} (${cred.source})`,
          };

    const prepared = mod.readPreparedState();
    const snapRes: CheckResult = prepared.base?.snapshotId
      ? {
          label: 'base snapshot',
          status: 'ok',
          detail: `${prepared.base.snapshotId.slice(0, 16)}… (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base snapshot',
          status: 'warn',
          detail: 'not baked',
          hint: '`agentbox prepare --provider vercel`',
        };
    return [credRes, snapRes];
  } catch (err) {
    return [
      {
        label: 'credentials',
        status: 'warn',
        detail: errSummary(err),
      },
    ];
  }
}

async function e2bChecks(): Promise<CheckResult[]> {
  try {
    const mod = await import('@agentbox/sandbox-e2b');
    const cred = mod.readE2bCredStatus();
    const credRes: CheckResult =
      cred.auth === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'not configured',
            hint: '`agentbox e2b login`',
          }
        : {
            label: 'credentials',
            status: 'ok',
            detail: `${cred.auth} (${cred.source})`,
          };

    const prepared = mod.readPreparedState();
    const tmplRes: CheckResult = prepared.base?.templateId
      ? {
          label: 'base template',
          status: 'ok',
          detail: `${prepared.base.templateName ?? prepared.base.templateId} (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base template',
          status: 'warn',
          detail: 'not baked',
          hint: '`agentbox prepare --provider e2b`',
        };
    return [credRes, tmplRes];
  } catch (err) {
    return [
      {
        label: 'credentials',
        status: 'warn',
        detail: errSummary(err),
      },
    ];
  }
}

export async function runProviderChecks(name: ProviderName): Promise<CheckGroup> {
  let results: CheckResult[];
  switch (name) {
    case 'docker':
      results = await dockerChecks();
      break;
    case 'daytona':
      results = await daytonaChecks();
      break;
    case 'hetzner':
      results = await hetznerChecks();
      break;
    case 'vercel':
      results = await vercelChecks();
      break;
    case 'e2b':
      results = await e2bChecks();
      break;
  }
  return { title: name, results };
}

export async function runAllChecks(): Promise<CheckGroup[]> {
  const sys: CheckGroup = { title: 'system', results: await runSystemChecks() };
  const providerGroups = await Promise.all(ALL_PROVIDERS.map((n) => runProviderChecks(n)));
  return [sys, ...providerGroups];
}

function worstInResults(results: CheckResult[]): CheckStatus {
  let worst: CheckStatus = 'ok';
  for (const r of results) {
    if (r.status === 'fail') return 'fail';
    if (r.status === 'warn') worst = 'warn';
  }
  return worst;
}

export function worstStatus(groups: CheckGroup[]): CheckStatus {
  let worst: CheckStatus = 'ok';
  for (const g of groups) {
    const w = worstInResults(g.results);
    if (w === 'fail') return 'fail';
    if (w === 'warn') worst = 'warn';
  }
  return worst;
}

function summaryToken(group: CheckGroup): string {
  const worst = worstInResults(group.results);
  if (group.title === 'system') {
    if (worst === 'fail') return 'system FAIL';
    if (worst === 'warn') return 'system warn';
    return 'system ok';
  }
  if (worst === 'fail') return `${group.title} FAIL`;
  if (worst === 'warn') {
    // Distinguish "not configured" (warn on credentials) from other warns.
    const cred = group.results.find((r) => r.label === 'credentials');
    if (cred && cred.status === 'warn') return `${group.title} login needed`;
    return `${group.title} not prepared`;
  }
  return `${group.title} ready`;
}

// Raw ANSI escapes (the repo's established color path — see dashboard/sidebar.ts).
const C_GREEN = '\x1b[32m';
const C_YELLOW = '\x1b[33m';
const C_RED = '\x1b[31m';
const C_RESET = '\x1b[0m';
const COLOR = !process.env.NO_COLOR; // install requires a TTY anyway; honor NO_COLOR for piped output

function statusMarker(s: CheckStatus): string {
  const glyph = s === 'ok' ? '✓' : s === 'warn' ? '⚠' : '✗';
  if (!COLOR) return glyph;
  const color = s === 'ok' ? C_GREEN : s === 'warn' ? C_YELLOW : C_RED;
  return `${color}${glyph}${C_RESET}`;
}

/** One-line summary used by the `install` wizard. */
export function formatCompact(groups: CheckGroup[]): string {
  return groups
    .map((g) => `${statusMarker(worstInResults(g.results))} ${summaryToken(g)}`)
    .join(' · ');
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function statusBadge(s: CheckStatus): string {
  if (s === 'ok') return '[ ok ]';
  if (s === 'warn') return '[warn]';
  return '[FAIL]';
}

/** Multi-line grouped report used by `agentbox doctor`. */
export function formatDetailed(groups: CheckGroup[]): string[] {
  const lines: string[] = [];
  for (const g of groups) {
    if (lines.length > 0) lines.push('');
    lines.push(`${g.title}:`);
    for (const r of g.results) {
      const badge = statusBadge(r.status);
      const tail = r.hint ? `  (${r.hint})` : '';
      lines.push(`  ${badge} ${pad(r.label, 18)} ${r.detail}${tail}`);
    }
  }
  return lines;
}
