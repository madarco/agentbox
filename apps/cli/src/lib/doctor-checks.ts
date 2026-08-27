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
import {
  loadEffectiveConfig,
  loadGrantedTools,
  type ProviderKind,
  type ToolGrant,
} from '@agentbox/config';
import {
  errSummary,
  firstLine,
  relayPort,
  statusBadge,
  type CheckResult,
  type CheckStatus,
} from '@agentbox/sandbox-core';
import { getRuntimeProviderNames, loadProviderModule } from '../provider/loaders.js';
import { dockerProvidersHidden, isDockerProvider } from '../control-plane/remote-hub.js';
import { evaluateBaseFreshness } from '../checkpoint-lookup.js';

// The per-provider health probes live in each `@agentbox/sandbox-<name>`
// package (`providerModule.doctorChecks`); this module just aggregates them
// with the system + host-tool checks. `CheckResult`/`CheckStatus` are the
// shared shape from sandbox-core.
export type { CheckResult, CheckStatus };

export interface CheckGroup {
  /** Group title: 'system' | a provider name | 'tools'. */
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
  const [git, ssh, sshfs, config] = await Promise.all([
    checkGit(),
    checkSsh(),
    checkSshfs(),
    checkConfig(),
  ]);
  const results = [checkNode(), checkPlatform(), checkAgentboxHome(), git, ssh, sshfs];
  results.push(...(await checkBoxesOnStaleRelayPort()));
  // macFUSE is a macOS concept; on Linux FUSE is a kernel module and sshfs alone
  // is the signal, so don't show a spurious row.
  if (process.platform === 'darwin') results.push(checkMacfuse());
  results.push(...config);
  return results;
}

/**
 * Docker boxes still dialling a relay port the host no longer serves.
 *
 * `AGENTBOX_HOST_RELAY_URL` is baked in by `docker run -e`, so it is fixed for
 * the container's life: changing `relay.port` leaves every existing box pointing
 * at the old port. The box does not fail loudly — its host actions come back as
 * `relay returned 502`, which reads like a flaky relay rather than a port
 * change. Naming it here is the whole point; the fix is to recreate the box.
 *
 * Best-effort and offline-safe: no docker daemon, no containers, or an
 * unreadable env all mean "nothing to report", never a failed check.
 */
async function checkBoxesOnStaleRelayPort(): Promise<CheckResult[]> {
  const port = relayPort();
  let stale: string[];
  try {
    const { stdout } = await execa(
      'docker',
      ['ps', '--filter', 'name=^/agentbox-', '--format', '{{.Names}}'],
      { timeout: 5000 },
    );
    const names = stdout
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length === 0) return [];
    const inspected = await execa(
      'docker',
      ['inspect', '--format', '{{.Name}}\t{{range .Config.Env}}{{println .}}{{end}}', ...names],
      { timeout: 8000 },
    );
    stale = [];
    for (const block of inspected.stdout.split(/^\/(?=agentbox-)/m)) {
      const name = /^(agentbox-[^\s\t]+)/.exec(block)?.[1];
      const url = /AGENTBOX_HOST_RELAY_URL=(\S+)/.exec(block)?.[1];
      if (!name || !url) continue;
      const boxPort = Number.parseInt(new URL(url).port, 10);
      if (Number.isFinite(boxPort) && boxPort !== port) stale.push(`${name} (:${String(boxPort)})`);
    }
  } catch {
    return [];
  }
  if (stale.length === 0) return [];
  return [
    {
      label: 'box relay port',
      status: 'warn',
      detail:
        `${stale.join(', ')} still dial a relay port this host no longer serves ` +
        `(relay.port is now ${String(port)}). Their host actions (git push, cp, checkpoint) ` +
        `will fail with a 502 — the port is baked in at create time, so recreate these boxes.`,
    },
  ];
}

/**
 * Surface non-fatal config issues (unknown keys — skipped, not applied). They
 * no longer abort commands, so doctor is where a user finds a typo'd key.
 */
async function checkConfig(): Promise<CheckResult[]> {
  let loaded;
  try {
    loaded = await loadEffectiveConfig(process.cwd());
  } catch (err) {
    return [{ label: 'config', status: 'warn', detail: errSummary(err) }];
  }
  if (loaded.warnings.length === 0) return [];
  return loaded.warnings.map((detail) => ({
    label: 'config',
    status: 'warn' as const,
    detail,
    hint: 'fix the key, or ignore this if it was set by a newer agentbox',
  }));
}

/**
 * Probe a binary, treating ENOENT (missing on PATH) as a distinct outcome
 * from a non-zero exit. `execa({reject:false})` returns a result envelope
 * even on spawn failure — `{ failed: true, code: 'ENOENT', exitCode: undefined }`
 * — rather than throwing. We map that to `missing: true` so the integration
 * check has a single, easy-to-read branch. Wrapped in try/catch in case a
 * future execa release reverts to throwing on spawn errors.
 */
// Doctor probes a host tool by running its CLI — a call that can stall, and
// that would block on an interactive prompt. Keep doctor snappy and un-hangable:
// cap each probe with a short timeout and never inherit stdin. (The relay uses
// a far longer budget for *real* ops; this is just a health check.)
const HOST_TOOL_PROBE_TIMEOUT_MS = 10_000;

async function probeHostToolBin(
  bin: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string; missing: boolean }> {
  try {
    const r = await execa(bin, [...args], {
      reject: false,
      timeout: HOST_TOOL_PROBE_TIMEOUT_MS,
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
        stderr: `timed out after ${String(HOST_TOOL_PROBE_TIMEOUT_MS)}ms`,
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

/**
 * One row per host tool granted to the project at `cwd`: is the host binary
 * actually installed, and does it run. Driven off the grant store, so a tool
 * added by `agentbox tools add` or by an approved in-box request shows up
 * here with no doctor change.
 *
 * The probe runs each binary with no forced env, exactly as the relay does —
 * so what doctor reports is the state the relay would actually hit.
 *
 * `loader` is injectable for unit tests.
 */
export async function toolsChecks(
  loader: (cwd: string) => Promise<Map<string, ToolGrant>> = (c) => loadGrantedTools(c),
): Promise<CheckResult[]> {
  let grants: Map<string, ToolGrant>;
  try {
    grants = await loader(process.cwd());
  } catch {
    grants = new Map();
  }
  const rows = [...grants.values()].sort((a, b) => a.name.localeCompare(b.name));
  // Independent probes; Promise.all keeps doctor latency flat as the grant
  // list grows.
  return Promise.all(rows.map((g) => checkOneTool(g)));
}

async function checkOneTool(grant: ToolGrant): Promise<CheckResult> {
  // `gh` is proxied by its own relay handler, which has its own doctor row
  // under the provider checks. Report it as present-by-default, not probed.
  if (grant.source === 'builtin') {
    return { label: grant.name, status: 'info', detail: 'built-in grant' };
  }
  const version = await probeHostToolBin(grant.bin, ['--version']);
  if (version.missing || version.exitCode === 127) {
    return {
      label: grant.name,
      status: 'warn',
      detail: `${grant.bin} not installed on the host`,
      hint: `install ${grant.bin}, or drop the grant with \`agentbox tools rm ${grant.name}\``,
    };
  }
  if (version.exitCode === 124) {
    return { label: grant.name, status: 'warn', detail: 'version probe timed out' };
  }
  const detail = firstLine((version.stdout || version.stderr).trim()) || grant.bin;
  // A non-zero `--version` is common for CLIs that spell it differently; the
  // binary resolving is what matters for the relay, so this stays `ok`.
  return { label: grant.name, status: 'ok', detail };
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
 * A "base freshness" row for every baked provider, docker included — warns when
 * the baked image/snapshot's build-context fingerprint no longer matches the
 * current runtime (a CLI upgrade changed a baked file), which is the same
 * staleness the wizard nags about at create time. Returns null for
 * not-yet-baked providers (the provider's own "base snapshot" row already says
 * so), and when the live fingerprint can't be computed (a dev tree without a
 * built runtime) — never a false 'stale'. Local + offline (just file hashing),
 * so it honours this module's offline-safe contract.
 */
async function baseFreshnessRow(name: ProviderName): Promise<CheckResult | null> {
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
    // Independent: the provider's own probes don't feed the freshness row (it
    // reads prepared-state + the local build context). Overlap them.
    const [results, fresh] = await Promise.all([mod.doctorChecks(), baseFreshnessRow(name)]);
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
  // Docker off under a remote hub (Step 12): drop docker/remote-docker rows when a
  // control box owns the fleet (hub.mode=local keeps them). A scoped `doctor -p
  // docker` still runs — this only trims the unscoped enumeration.
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  const hideDocker = cfg ? dockerProvidersHidden(cfg.effective) : false;
  const providerNames = getRuntimeProviderNames().filter(
    (n) => !hideDocker || !isDockerProvider(n),
  );
  // The three phases are independent, so run them together: wall time is the
  // slowest phase, not their sum. (`doctor --provider X` already did this —
  // see runDoctor's Promise.all — so unscoped doctor was the slow path.)
  const [sysResults, providerGroups, toolResults] = await Promise.all([
    runSystemChecks(),
    Promise.all(providerNames.map((n) => runProviderChecks(n))),
    toolsChecks(),
  ]);
  return [
    { title: 'system', results: sysResults },
    ...providerGroups,
    { title: 'tools', results: toolResults },
  ];
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
    // Name what warned so the one-liner is actionable without running doctor;
    // deps whose hint says "optional" are labelled as such (they don't block).
    if (worst === 'warn') {
      const warns = group.results.filter((r) => r.status === 'warn');
      const required = warns.filter((r) => !r.hint?.startsWith('optional')).map((r) => r.label);
      const optional = warns.filter((r) => r.hint?.startsWith('optional')).map((r) => r.label);
      const parts = [...required];
      if (optional.length > 0) parts.push(`optional ${optional.join(', ')}`);
      return `system warn: ${parts.join(', ')}`;
    }
    return 'system ok';
  }
  if (group.title === 'tools') {
    if (worst === 'fail') return 'tools FAIL';
    if (worst === 'warn') return 'tools check';
    // Every row info (only the built-in gh grant) reads as "none granted".
    const anyGranted = group.results.some((r) => r.status === 'ok');
    return anyGranted ? 'tools ready' : 'tools none';
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
