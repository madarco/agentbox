/**
 * Host-side machinery for the `tool.*` RPCs — the relay-side spine that lets
 * an in-box agent drive an arbitrary host CLI without ever holding that CLI's
 * credentials.
 *
 * The gate lives here, not in the box. The in-box shim is a three-line
 * forwarder by design (it was never the security boundary — see
 * docs/architecture.md); this file is the only thing that consults the grant
 * list, the built-in credential deny list, the per-tool argv rules and the
 * host approval prompt. One check covers every caller: the shim, a direct
 * `agentbox-ctl tool run`, and the cloud executor.
 *
 * Lives in its own file so both `server.ts` (docker `POST /rpc`) and
 * `host-actions.ts` (cloud path) share it — same cycle-avoidance reasoning
 * as `gh.ts`.
 */

import { loadEffectiveConfig, loadGrantedTools, type ToolGrant } from '@agentbox/config';
import { assertHostBinReady, hostBinExists, runHostBinary } from './host-exec.js';
import type { GitRpcResult } from './types.js';

/** Wire params for `tool.run`. */
export interface ToolRunRpcParams {
  /** Container path the ctl ran in; picks the registered worktree. */
  path?: string;
  /** Tool name, as granted. */
  name?: string;
  /** Argv forwarded verbatim to the host binary. */
  args?: string[];
}

/** Wire params for `tool.request`. */
export interface ToolRequestRpcParams {
  path?: string;
  name?: string;
  /** Free text the agent supplies, shown to the human in the prompt. */
  reason?: string;
}

/** Wire params for `tool.list`. */
export interface ToolListRpcParams {
  path?: string;
  /**
   * `'json'` returns a machine-readable grant array on stdout instead of the
   * human table. The in-box daemon uses it to keep the per-tool shim symlinks
   * in sync with the grant list — that is what makes an approval take effect
   * without restarting the box.
   */
  format?: 'text' | 'json';
}

/**
 * Argv shapes that make a host CLI print a credential to stdout. Refused
 * unconditionally — before the per-tool rules, before any prompt, before any
 * spawn — because the box would capture the output. This is the generic
 * replacement for the old linear connector's bespoke `auth token` reject.
 *
 * Matched case-insensitively against the space-joined argv. Deliberately
 * broad: a false positive costs the user one `--allow` pattern, a false
 * negative leaks a host credential into an untrusted box.
 */
export const CREDENTIAL_ARGV_PATTERNS: readonly RegExp[] = [
  /\bauth\s+(token|print-token|print-access-token|export)\b/i,
  /\bprint-access-token\b/i,
  /\bprint-identity-token\b/i,
  /\bget-token\b/i,
  /\bexport-credentials\b/i,
  /\bconfigure\s+get\b/i,
  /\bsecrets?\s+(get|reveal|show|print)\b/i,
  /\bcredentials?\s+(get|reveal|show|print)\b/i,
  /--show-secret\b/i,
  /\btoken\s+--raw\b/i,
];

/** Ready-to-send refusal when the argv would print a host credential. */
export function refuseCredentialArgv(name: string, args: readonly string[]): GitRpcResult | null {
  const joined = args.join(' ');
  for (const re of CREDENTIAL_ARGV_PATTERNS) {
    if (re.test(joined)) {
      return {
        exitCode: 65,
        stdout: '',
        stderr:
          `${name}: refused — '${joined}' prints a host credential, which would land ` +
          `inside the box. The host runs this tool so the box never needs its token.\n`,
      };
    }
  }
  return null;
}

/** Per-tool `deny` rules from the grant. Runs after the built-in list. */
export function refuseDeniedArgv(grant: ToolGrant, args: readonly string[]): GitRpcResult | null {
  if (!grant.deny || grant.deny.length === 0) return null;
  const joined = args.join(' ');
  for (const pattern of grant.deny) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      // A grant file with a bad regex must not silently stop denying.
      return {
        exitCode: 78,
        stdout: '',
        stderr: `${grant.name}: grant has an invalid deny pattern '${pattern}'\n`,
      };
    }
    if (re.test(joined)) {
      return {
        exitCode: 65,
        stdout: '',
        stderr: `${grant.name}: refused — argv matches this tool's deny rule '${pattern}'\n`,
      };
    }
  }
  return null;
}

/**
 * True when the argv matches one of the grant's `allow` patterns, meaning it
 * runs with no prompt regardless of the box's auto-approve setting. An
 * invalid pattern never matches (fail closed → the call just gets prompted).
 */
export function argvIsExplicitlyAllowed(grant: ToolGrant, args: readonly string[]): boolean {
  if (!grant.allow || grant.allow.length === 0) return false;
  const joined = args.join(' ');
  return grant.allow.some((pattern) => {
    try {
      return new RegExp(pattern).test(joined);
    } catch {
      return false;
    }
  });
}

/**
 * Resolve the grant for `name` under `cwd`, or a ready-to-send refusal.
 * Re-reads the grant files on every call so an approval takes effect without
 * bouncing the relay — same live-flip approach the autopause loop uses.
 * Fails closed: an unreadable grant file yields no grants.
 */
export async function resolveToolGrant(
  name: string,
  cwd: string,
  loader: (cwd: string) => Promise<Map<string, ToolGrant>> = (c) => loadGrantedTools(c),
): Promise<{ grant: ToolGrant } | { refusal: GitRpcResult }> {
  let grants: Map<string, ToolGrant>;
  try {
    grants = await loader(cwd);
  } catch {
    grants = new Map();
  }
  const grant = grants.get(name);
  if (!grant) {
    return {
      refusal: {
        exitCode: 65,
        stdout: '',
        stderr:
          `${name} is not a granted host tool for this project. Grant it on the host with ` +
          `\`agentbox tools add ${name}\`, or ask from inside the box with ` +
          `\`agentbox-ctl tool request ${name}\`.\n`,
      },
    };
  }
  // `gh` keeps its own relay handler (branch injection, the `gh api` endpoint
  // allowlist). Routing it through the generic path would quietly drop those
  // guards, so refuse rather than silently downgrade.
  if (grant.source === 'builtin') {
    return {
      refusal: {
        exitCode: 65,
        stdout: '',
        stderr: `${name} is handled by its own relay path, not the generic host-tool proxy\n`,
      },
    };
  }
  return { grant };
}

/** Whether boxes may raise access requests at all (`tools.request.enabled`). */
export async function toolRequestsEnabled(
  cwd: string,
  loader: (cwd: string) => Promise<{
    effective: { tools?: { request?: { enabled?: boolean } } };
  }> = loadEffectiveConfig,
): Promise<boolean> {
  try {
    const cfg = await loader(cwd);
    return cfg.effective.tools?.request?.enabled !== false;
  } catch {
    // Malformed config fails closed — a box shouldn't get to prompt the user
    // because the host's config didn't parse.
    return false;
  }
}

/** Whether the built-in `gh` grant is live (`tools.gh.enabled`). */
export async function ghToolEnabled(
  cwd: string,
  loader: (cwd: string) => Promise<{
    effective: { tools?: { gh?: { enabled?: boolean } } };
  }> = loadEffectiveConfig,
): Promise<boolean> {
  try {
    const cfg = await loader(cwd);
    return cfg.effective.tools?.gh?.enabled !== false;
  } catch {
    // Unlike a tool grant, gh fails OPEN on an unreadable config: it is on by
    // default and agent flows (Claude Code's PR badge) depend on it, so a
    // malformed config should not silently break PR operations.
    return true;
  }
}

/**
 * Ready-to-send refusal when `tools.gh.enabled` is false, else null. The
 * relay-side half of revoking the built-in grant — without this the config
 * key would be documentation with no effect.
 */
export async function refuseIfGhDisabled(
  cwd: string,
  loader?: Parameters<typeof ghToolEnabled>[1],
): Promise<GitRpcResult | null> {
  if (await ghToolEnabled(cwd, loader)) return null;
  return {
    exitCode: 65,
    stdout: '',
    stderr:
      'gh is disabled for this project — re-enable with ' +
      '`agentbox config set --project tools.gh.enabled true`\n',
  };
}

/** Probe the host for a binary the box asked for. */
export async function hostToolInstalled(bin: string): Promise<boolean> {
  return hostBinExists(bin);
}

/** Spawn the granted tool in the worktree's host repo. */
export async function runGrantedTool(
  grant: ToolGrant,
  args: readonly string[],
  cwd: string,
): Promise<GitRpcResult> {
  const ready = await assertHostBinReady(grant.bin);
  if (ready) return ready;
  return runHostBinary(grant.bin, args, cwd, grant.timeoutMs);
}

/** Machine-readable `tool.list` payload for the in-box daemon. */
export function renderToolListJson(grants: Iterable<ToolGrant>): string {
  const rows = [...grants]
    .filter((g) => g.source !== 'builtin')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({ name: g.name, bin: g.bin }));
  return JSON.stringify({ tools: rows }) + '\n';
}

/** Rendered `tool.list` payload. One line per granted tool. */
export function renderToolList(grants: Iterable<ToolGrant>): string {
  const rows = [...grants].sort((a, b) => a.name.localeCompare(b.name));
  if (rows.length === 0) {
    return 'no host tools granted for this project\n';
  }
  const width = Math.max(...rows.map((g) => g.name.length));
  return (
    rows
      .map((g) => {
        const notes: string[] = [`host: ${g.bin}`, g.source];
        if (g.allow) notes.push(`${String(g.allow.length)} allow`);
        if (g.deny) notes.push(`${String(g.deny.length)} deny`);
        return `${g.name.padEnd(width)}  ${notes.join('  ')}`;
      })
      .join('\n') + '\n'
  );
}
