/**
 * Shared compatibility/status checks consumed by `agentbox doctor` (full
 * detail) and `agentbox install` (compact one-line summary).
 *
 * All probes are local, read-only, and offline-safe — they never call out to
 * a cloud API. Remote snapshot inventory lives in `agentbox prepare --status`.
 */

import { accessSync, constants as fsConstants, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { loadEffectiveConfig, type ProviderKind } from '@agentbox/config';
import { errSummary, firstLine, type CheckResult, type CheckStatus } from '@agentbox/sandbox-core';
import { ALL_CONNECTORS, type IntegrationConnector } from '@agentbox/integrations';
import { getRuntimeProviderNames, loadProviderModule } from '../provider/loaders.js';
import { evaluateBaseFreshness } from '../checkpoint-lookup.js';

// The per-provider health probes live in each `@agentbox/sandbox-<name>`
// package (`providerModule.doctorChecks`); this module just aggregates them
// with the system + integration checks. `CheckResult`/`CheckStatus` are the
// shared shape from sandbox-core.
export type { CheckResult, CheckStatus };

export interface CheckGroup {
  /** Group title: 'system' | a provider name | 'integrations'. */
  title: string;
  results: CheckResult[];
}

/** Provider group name — a built-in `ProviderKind` or a registered plugin provider. */
export type ProviderName = ProviderKind | (string & {});

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

/** True when `bin` resolves on PATH (definitive install check, no version-flag quirks). */
async function onPath(bin: string): Promise<string | null> {
  const r = await execa('which', [bin], { reject: false });
  if (r.exitCode !== 0) return null;
  const p = (r.stdout ?? '').trim();
  return p.length > 0 ? p : null;
}

// sshfs + macFUSE are OPTIONAL deps of `agentbox open` (the sshfs live-mount of a
// box's /workspace), so a miss is `warn`, never `fail`.
async function checkSshfs(): Promise<CheckResult> {
  const path = await onPath('sshfs');
  if (path) return { label: 'sshfs', status: 'ok', detail: path };
  const hint =
    process.platform === 'darwin'
      ? 'optional: `brew install macfuse sshfs` — needed for `agentbox open` (sshfs mount)'
      : 'optional: install sshfs (e.g. `apt install sshfs`) — needed for `agentbox open` (sshfs mount)';
  return { label: 'sshfs', status: 'warn', detail: 'not found', hint };
}

/** macOS-only: macFUSE isn't a PATH binary — probe its filesystem bundle. */
function checkMacfuse(): CheckResult {
  const present =
    existsSync('/Library/Filesystems/macfuse.fs') || existsSync('/Library/Filesystems/osxfuse.fs');
  return present
    ? { label: 'macfuse', status: 'ok', detail: '/Library/Filesystems/macfuse.fs' }
    : {
        label: 'macfuse',
        status: 'warn',
        detail: 'not installed',
        hint: 'optional: `brew install macfuse` — the FUSE backend `agentbox open` mounts through',
      };
}

export async function runSystemChecks(): Promise<CheckResult[]> {
  const [git, ssh, sshfs] = await Promise.all([checkGit(), checkSsh(), checkSshfs()]);
  const results = [checkNode(), checkPlatform(), checkAgentboxHome(), git, ssh, sshfs];
  // macFUSE is a macOS concept; on Linux FUSE is a kernel module and sshfs alone
  // is the signal, so don't show a spurious row.
  if (process.platform === 'darwin') results.push(checkMacfuse());
  return results;
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

// `box.claudeInstall` folds into the base-image fingerprint, so freshness must
// compare against the variant the user would actually bake with. Resolve it once
// per doctor run (memoized) from the effective config at cwd; default 'native'.
let claudeInstallOnce: Promise<'native' | 'npm'> | undefined;
function resolveClaudeInstall(): Promise<'native' | 'npm'> {
  claudeInstallOnce ??= loadEffectiveConfig(process.cwd())
    .then((cfg): 'native' | 'npm' => (cfg.effective.box.claudeInstall === 'npm' ? 'npm' : 'native'))
    .catch((): 'native' | 'npm' => 'native');
  return claudeInstallOnce;
}

/**
 * A "base freshness" row for baked cloud providers — warns when the baked
 * snapshot's build-context fingerprint no longer matches the current runtime
 * (a CLI upgrade changed a baked file), which is the same staleness the wizard
 * nags about at create time. Returns null for docker (self-heals), for
 * not-yet-baked providers (the provider's own "base snapshot" row already says
 * so), and when the live fingerprint can't be computed (a dev tree without a
 * built runtime) — never a false 'stale'. Local + offline (just file hashing),
 * so it honours this module's offline-safe contract.
 */
async function baseFreshnessRow(name: ProviderName): Promise<CheckResult | null> {
  if (name === 'docker') return null;
  const status = await evaluateBaseFreshness(name, await resolveClaudeInstall()).catch(() => null);
  if (!status) return null;
  switch (status.state) {
    case 'stale':
      return {
        label: 'base freshness',
        status: 'warn',
        detail: `stale — ${status.reason}`,
        hint: `fix with: \`agentbox prepare --provider ${name}\``,
      };
    case 'fresh':
      return { label: 'base freshness', status: 'ok', detail: 'up to date' };
    default:
      // 'unprepared' (covered by the provider's base-snapshot row) / 'unknown'
      // (unverifiable) — stay silent rather than add an inert row.
      return null;
  }
}

export async function runProviderChecks(name: ProviderName): Promise<CheckGroup> {
  try {
    const mod = await loadProviderModule(name);
    const results = await mod.doctorChecks();
    const fresh = await baseFreshnessRow(name);
    return { title: name, results: fresh ? [...results, fresh] : results };
  } catch (err) {
    // A broken/incompatible plugin must not crash `doctor` — surface it as a warn.
    return {
      title: name,
      results: [{ label: 'plugin', status: 'warn', detail: errSummary(err) }],
    };
  }
}

export async function runAllChecks(): Promise<CheckGroup[]> {
  const sys: CheckGroup = { title: 'system', results: await runSystemChecks() };
  const providerGroups = await Promise.all(
    getRuntimeProviderNames().map((n) => runProviderChecks(n)),
  );
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
