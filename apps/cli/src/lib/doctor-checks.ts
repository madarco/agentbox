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
import { loadEffectiveConfig } from '@agentbox/config';
import { ALL_CONNECTORS, type IntegrationConnector } from '@agentbox/integrations';

/**
 * `info` is for rows that are intentionally inert (e.g. an integration the
 * user hasn't enabled). It surfaces as a distinct glyph but rolls up like
 * `ok` so it never pushes the overall doctor status to "warn" — disabling
 * Notion is a setting, not a problem.
 */
export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail';

export interface CheckResult {
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface CheckGroup {
  /** Group title: 'system' | 'docker' | 'daytona' | 'hetzner' | 'vercel' | 'e2b' | 'tenki'. */
  title: string;
  results: CheckResult[];
}

export type ProviderName = 'docker' | 'daytona' | 'hetzner' | 'vercel' | 'e2b' | 'tenki';

const ALL_PROVIDERS: ProviderName[] = ['docker', 'daytona', 'hetzner', 'vercel', 'e2b', 'tenki'];
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

async function tenkiChecks(): Promise<CheckResult[]> {
  try {
    const mod = await import('@agentbox/sandbox-tenki');
    const cred = mod.readTenkiCredStatus();
    const credRes: CheckResult =
      cred.auth === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'not configured',
            hint: '`agentbox tenki login`',
          }
        : {
            label: 'credentials',
            status: 'ok',
            detail: `${cred.auth} (${cred.source})`,
          };

    const prepared = mod.readPreparedState();
    const imgRes: CheckResult = prepared.base?.image
      ? {
          label: 'base image',
          status: 'ok',
          detail: `${prepared.base.imageName ?? prepared.base.image} (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base image',
          status: 'warn',
          detail: 'not prepared',
          hint: '`agentbox prepare --provider tenki`',
        };
    return [credRes, imgRes];
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

/**
 * Probe a binary, treating ENOENT (missing on PATH) as a distinct outcome
 * from a non-zero exit. `execa({reject:false})` returns a result envelope
 * even on spawn failure — `{ failed: true, code: 'ENOENT', exitCode: undefined }`
 * — rather than throwing. We map that to `missing: true` so the integration
 * check has a single, easy-to-read branch. Wrapped in try/catch in case a
 * future execa release reverts to throwing on spawn errors.
 */
// Doctor probes a connector's auth state by running its CLI (e.g. `ntn api
// v1/users/me`, `linear auth whoami`) — network calls that can stall, and that
// would block on an interactive prompt. Keep doctor snappy and un-hangable:
// cap each probe with a short timeout and never inherit stdin. (The relay uses
// a far longer budget for *real* ops; this is just a health check.)
const INTEGRATION_PROBE_TIMEOUT_MS = 10_000;

async function probeIntegrationBin(
  bin: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string; missing: boolean }> {
  try {
    const r = await execa(bin, [...args], {
      reject: false,
      timeout: INTEGRATION_PROBE_TIMEOUT_MS,
      stdin: 'ignore',
    });
    const code = (r as { code?: string }).code;
    if (code === 'ENOENT') {
      return { exitCode: 127, stdout: '', stderr: r.stderr ?? '', missing: true };
    }
    if ((r as { timedOut?: boolean }).timedOut) {
      return {
        exitCode: 124,
        stdout: '',
        stderr: `timed out after ${String(INTEGRATION_PROBE_TIMEOUT_MS)}ms`,
        missing: false,
      };
    }
    return {
      exitCode: r.exitCode ?? 1,
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
      missing: false,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      exitCode: code === 'ENOENT' ? 127 : 1,
      stdout: '',
      stderr: errSummary(err),
      missing: code === 'ENOENT',
    };
  }
}

/** Shape `loadEffectiveConfig` returns; only the integrations slice matters here. */
type IntegrationsConfigSlice = {
  effective: { integrations?: Record<string, { enabled?: boolean } | undefined> };
};

export type IntegrationsConfigLoader = (cwd: string) => Promise<IntegrationsConfigSlice>;

/**
 * Per-connector host-side detection: is each `integrations.<svc>.enabled`
 * flipped on, is the host CLI installed, and is the user logged in. Driven
 * off `ALL_CONNECTORS` so Linear/Trello light up here automatically when
 * they ship — no doctor change needed.
 *
 * `loader` is injectable for unit tests (mirrors `refuseIfIntegrationDisabled`'s
 * approach). The default reads layered config from `cwd`, so toggling the
 * flag via `agentbox config set` takes effect on the next doctor run with
 * no caching.
 *
 * The auth probe runs each connector's CLI with no forced env, exactly as the
 * relay does — so a host's real authed state (e.g. the macOS keychain after
 * `ntn login`) is what's reported, and doctor can't show "authed" for a path
 * the relay wouldn't actually use.
 */
export async function integrationsChecks(
  loader: IntegrationsConfigLoader = loadEffectiveConfig,
): Promise<CheckResult[]> {
  let cfg: IntegrationsConfigSlice;
  try {
    cfg = await loader(process.cwd());
  } catch {
    cfg = { effective: {} };
  }
  // Parallel: each connector's two probes (version + auth) are independent
  // across connectors. With Linear / Trello / ClickUp queued, the serial
  // walk would scale linearly; Promise.all keeps doctor latency flat.
  return Promise.all(
    ALL_CONNECTORS.map((connector) => checkOneIntegration(connector, cfg.effective.integrations)),
  );
}

async function checkOneIntegration(
  connector: IntegrationConnector,
  integrations: Record<string, { enabled?: boolean } | undefined> | undefined,
): Promise<CheckResult> {
  const svc = connector.service;
  const enabled = integrations?.[svc]?.enabled === true;
  if (!enabled) {
    return {
      label: svc,
      status: 'info',
      detail: 'disabled',
      hint: `enable with \`agentbox config set --project integrations.${svc}.enabled true\``,
    };
  }

  const version = await probeIntegrationBin(connector.hostBin, connector.detect.versionArgs);
  if (version.missing || version.exitCode === 127) {
    return {
      label: svc,
      status: 'warn',
      detail: `${connector.hostBin} not installed`,
      hint:
        connector.detect.installHint ??
        `install the ${svc} CLI (\`${connector.hostBin}\`) on the host`,
    };
  }
  if (version.exitCode !== 0) {
    const tail = firstLine((version.stderr || version.stdout).trim());
    return {
      label: svc,
      status: 'warn',
      detail: `${connector.hostBin} ${connector.detect.versionArgs.join(' ')} failed${tail ? `: ${tail}` : ''}`,
    };
  }
  const versionLine = firstLine((version.stdout || version.stderr).trim()) || connector.hostBin;

  if (!connector.detect.authArgs || connector.detect.authArgs.length === 0) {
    return { label: svc, status: 'ok', detail: versionLine };
  }

  const auth = await probeIntegrationBin(connector.hostBin, connector.detect.authArgs);
  // A timed-out probe (124) means the CLI is installed but its auth check
  // stalled — report that, don't claim the user is logged out.
  if (auth.exitCode === 124) {
    return {
      label: svc,
      status: 'warn',
      detail: `auth check timed out after ${String(INTEGRATION_PROBE_TIMEOUT_MS / 1000)}s`,
    };
  }
  if (auth.exitCode !== 0) {
    return {
      label: svc,
      status: 'warn',
      detail: 'not logged in',
      hint: connector.detect.loginHint ?? `run \`${connector.hostBin} login\``,
    };
  }
  return { label: svc, status: 'ok', detail: `${versionLine} · authed` };
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
    case 'tenki':
      results = await tenkiChecks();
      break;
  }
  return { title: name, results };
}

export async function runAllChecks(): Promise<CheckGroup[]> {
  const sys: CheckGroup = { title: 'system', results: await runSystemChecks() };
  const providerGroups = await Promise.all(ALL_PROVIDERS.map((n) => runProviderChecks(n)));
  const integrations: CheckGroup = { title: 'integrations', results: await integrationsChecks() };
  return [sys, ...providerGroups, integrations];
}

function worstInResults(results: CheckResult[]): CheckStatus {
  let worst: CheckStatus = 'ok';
  for (const r of results) {
    if (r.status === 'fail') return 'fail';
    if (r.status === 'warn') worst = 'warn';
    // `info` rolls up like `ok` — intentionally inert rows shouldn't flip
    // the overall doctor status.
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
  if (group.title === 'integrations') {
    if (worst === 'fail') return 'integrations FAIL';
    if (worst === 'warn') return 'integrations check';
    // All rows ok or info (disabled) — render as "off" when every row is
    // info, else "ready" when at least one is enabled and green.
    const anyEnabled = group.results.some((r) => r.status === 'ok');
    return anyEnabled ? 'integrations ready' : 'integrations off';
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
const C_DIM = '\x1b[2m';
const C_RESET = '\x1b[0m';
const COLOR = !process.env.NO_COLOR; // install requires a TTY anyway; honor NO_COLOR for piped output

function statusMarker(s: CheckStatus): string {
  const glyph = s === 'ok' ? '✓' : s === 'info' ? '·' : s === 'warn' ? '⚠' : '✗';
  if (!COLOR) return glyph;
  const color = s === 'ok' ? C_GREEN : s === 'info' ? C_DIM : s === 'warn' ? C_YELLOW : C_RED;
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
  if (s === 'info') return '[info]';
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
