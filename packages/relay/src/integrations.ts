/**
 * Generic host-side machinery for the `integration.<service>.<op>` RPCs —
 * the relay-side spine that turns a descriptor in `@agentbox/integrations`
 * into a host-CLI invocation with read/write classification and write
 * gating. Companion to `gh.ts`: same spawn/probe/cache shape, but driven
 * by a descriptor (so each service is one small file in
 * `@agentbox/integrations/connectors/`, not a new pair of files here).
 *
 * Lives in its own file so both `server.ts` (docker `POST /rpc`) and
 * `host-actions.ts` (cloud path) share the same helpers — same cycle-
 * avoidance reasoning as `gh.ts`.
 */

import { spawn } from 'node:child_process';
import type { IntegrationConnector, IntegrationOp } from '@agentbox/integrations';
import type { GitRpcResult } from './types.js';

/** Wire params for every `integration.<service>.<op>` method. Mirrors GhPrRpcParams. */
export interface IntegrationRpcParams {
  /** Container path the ctl ran in; used to pick the registered worktree. */
  path?: string;
  /** Pass-through argv forwarded to the host CLI (after `op.buildArgv`). */
  args?: string[];
  /**
   * One-time token minted by the host CLI via `/admin/host-initiated/mint`
   * before invoking `agentbox-ctl integration <svc> <op>`. Validated against
   * the relay's in-memory store, scoped to `(boxId, method=integration.<svc>.<op>)`
   * and the params-hash; consumed on match and the confirm prompt is
   * skipped. Boxes cannot mint tokens (admin endpoint is loopback-only).
   * Reserved for T1's host-CLI surface (T3+) — agent-initiated ctl calls
   * never pass it; the `askPrompt` gate applies.
   */
  hostInitiated?: string;
}

const INTEGRATION_RPC_TIMEOUT_MS = 120_000;
const INTEGRATION_READY_CACHE_TTL_MS = 60_000;

/**
 * `integration.<service>.<op>` wire shape:
 *   - service: lowercase ASCII, matches IntegrationConnector.service.
 *   - op:      lowercase ASCII + digits + dots; first char a letter
 *              (excludes leading `.` shapes like `integration.notion..api`).
 *
 * Dots are allowed in the op portion so descriptor ops can use a
 * dotted-namespace form (e.g. `page.create`) without colliding with the
 * `integration.<svc>.<op>` delimiter — the parser splits on the FIRST two
 * dots and keeps everything after as the op (so e.g.
 * `integration.notion.page.create` parses to `{service:'notion', op:'page.create'}`).
 */
const INTEGRATION_METHOD_RE = /^integration\.([a-z][a-z0-9]*)\.([a-z][a-z0-9.]*)$/;

export interface ParsedIntegrationMethod {
  service: string;
  op: string;
}

/** Parse `integration.<service>.<op>`; returns null on shape miss. */
export function parseIntegrationMethod(method: string): ParsedIntegrationMethod | null {
  const m = INTEGRATION_METHOD_RE.exec(method);
  if (!m) return null;
  const service = m[1]!;
  const op = m[2]!;
  // Disallow a trailing dot (`integration.notion.api.`) or consecutive dots
  // (`integration.notion.page..create`) — the regex's `[a-z0-9.]*` is
  // permissive on purpose; we reject the degenerate shapes here.
  if (op.endsWith('.') || op.includes('..')) return null;
  return { service, op };
}

interface IntegrationReadyCacheEntry {
  /** null on success; ready-to-send error envelope when the binary isn't usable. */
  result: GitRpcResult | null;
  expiresAt: number;
}
const integrationReadyCache = new Map<string, IntegrationReadyCacheEntry>();

/**
 * Returns `null` when the host has the connector's binary on PATH;
 * otherwise a ready-to-send `{ exitCode, stdout, stderr }` envelope
 * describing what's missing. Cached per `connector.hostBin` for ~60s so a
 * burst of integration ops doesn't reprobe on every call (same TTL as
 * `assertGhReady`).
 *
 * - binary missing → exit 127 (matches Bash's "command not found").
 * - binary present but `--version` non-zero → propagate that exit.
 *
 * Auth-status is intentionally NOT probed here — `ntn` exits non-zero with
 * a clear "not logged in" message on every call when unauthed, which
 * surfaces directly through the relay's stdout/stderr passthrough. A
 * dedicated `auth` probe is the `agentbox doctor` flow (T3), not the
 * per-call hot path.
 */
export async function assertIntegrationReady(
  connector: IntegrationConnector,
): Promise<GitRpcResult | null> {
  const now = Date.now();
  const cached = integrationReadyCache.get(connector.hostBin);
  if (cached && cached.expiresAt > now) return cached.result;
  const result = await probeIntegration(connector);
  integrationReadyCache.set(connector.hostBin, {
    result,
    expiresAt: now + INTEGRATION_READY_CACHE_TTL_MS,
  });
  return result;
}

/** Test-only: clear the readiness cache between cases. */
export function _resetIntegrationReadyCacheForTests(): void {
  integrationReadyCache.clear();
}

async function probeIntegration(
  connector: IntegrationConnector,
): Promise<GitRpcResult | null> {
  const version = await runHostBinary(
    connector,
    [...connector.detect.versionArgs],
    process.cwd(),
    10_000,
  );
  if (version.exitCode === 127 || /ENOENT/.test(version.stderr)) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: `${connector.hostBin} not installed on host (install the ${connector.service} CLI on the host)\n`,
    };
  }
  if (version.exitCode !== 0) {
    return {
      exitCode: version.exitCode,
      stdout: '',
      stderr:
        `${connector.hostBin} ${connector.detect.versionArgs.join(' ')} failed: ` +
        (version.stderr || version.stdout).trimEnd() +
        '\n',
    };
  }
  return null;
}

/**
 * Spawn the connector's host binary with the given op + user args inside
 * `cwd`. Returns the standard `{ exitCode, stdout, stderr }` envelope.
 * `op.buildArgv` (when supplied) shapes the host CLI's subcommand path;
 * absent, the user args are forwarded verbatim. Connector env vars
 * (e.g. `NOTION_KEYRING=0`) are merged onto `process.env` via
 * `mergeConnectorEnv` — a descriptor that tries to set an env var
 * outside its `<SERVICE>_*` namespace yields a typed exit-78 envelope
 * (sysexits EX_CONFIG) rather than throwing, so the docker /rpc and
 * cloud paths both surface the misconfiguration as a normal envelope.
 *
 * Self-contained (no import dependency on the rest of the relay), same
 * cycle-avoidance reasoning as `runHostGh` in `gh.ts`.
 */
export function runHostIntegration(
  connector: IntegrationConnector,
  op: IntegrationOp,
  args: readonly string[],
  cwd: string,
  timeoutMs: number = INTEGRATION_RPC_TIMEOUT_MS,
): Promise<GitRpcResult> {
  const argv = op.buildArgv ? op.buildArgv(args) : [...args];
  return runHostBinary(connector, argv, cwd, timeoutMs);
}

/**
 * Merge the relay's `process.env` with the connector's declared overrides,
 * but only let the connector set env vars whose names are in its
 * `<SERVICE>_…` namespace (or other deliberately-shared names) — never
 * relay-controlled prefixes like `AGENTBOX_*`, `PATH`, `HOME`, etc. A
 * careless future descriptor cannot disable the relay's prompt gate or
 * rewrite PATH by setting `env: { AGENTBOX_PROMPT: 'off' }`.
 */
function mergeConnectorEnv(connector: IntegrationConnector): NodeJS.ProcessEnv {
  if (!connector.env) return process.env;
  const allowedPrefix = `${connector.service.toUpperCase()}_`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(connector.env)) {
    if (!key.startsWith(allowedPrefix)) {
      throw new Error(
        `integration ${connector.service}: env key '${key}' not in '${allowedPrefix}*' namespace; descriptor cannot set it`,
      );
    }
    env[key] = value;
  }
  return env;
}

function runHostBinary(
  connector: IntegrationConnector,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitRpcResult> {
  let env: NodeJS.ProcessEnv;
  try {
    env = mergeConnectorEnv(connector);
  } catch (err) {
    // Bad descriptor — return a typed envelope so the in-box ctl prints
    // the actual cause instead of an opaque relay "internal error" 500.
    return Promise.resolve({
      exitCode: 78,
      stdout: '',
      stderr: `${connector.hostBin}: ${err instanceof Error ? err.message : String(err)}\n`,
    });
  }
  return new Promise<GitRpcResult>((resolve) => {
    const child = spawn(connector.hostBin, [...argv], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      stderr += `\nrelay: ${connector.hostBin} command timed out after ${String(timeoutMs)}ms\n`;
      finish(124);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT (binary missing) lands here too; surface as exit 127.
      const code = (err as NodeJS.ErrnoException).code;
      stderr += String(err.message ?? err);
      finish(code === 'ENOENT' ? 127 : 1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code ?? -1);
    });
  });
}

/** Ready-to-send refusal for an op not on the connector's allowlist. */
export function makeIntegrationOpRefusal(
  service: string,
  op: string,
  hostBin: string,
  knownOps: readonly string[],
): GitRpcResult {
  return {
    exitCode: 65,
    stdout: '',
    stderr:
      `integration ${service}: op '${op}' not on allowlist for ${hostBin}. ` +
      `Available: ${knownOps.join(', ')}\n`,
  };
}

/**
 * Run the op's `refuseCall` pre-flight (e.g. `notion.api`'s GET-only check)
 * and lift its `{exitCode, stderr}` shape into the relay's full
 * `GitRpcResult`. Returns null when the call may proceed.
 */
export function refuseIntegrationCall(
  op: IntegrationOp,
  args: readonly string[],
): GitRpcResult | null {
  const refusal = op.refuseCall?.(args);
  if (!refusal) return null;
  return { exitCode: refusal.exitCode, stdout: '', stderr: refusal.stderr };
}
