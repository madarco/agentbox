/**
 * Generic host-binary spawn + readiness probe, shared by every relay path
 * that runs a host CLI on behalf of a box (`host-tools.ts` today; `gh.ts`
 * keeps its own `runHostGh` because it layers gh-specific target/env
 * resolution on top).
 *
 * Self-contained on purpose — no import dependency on the rest of the relay,
 * so both `server.ts` (docker `POST /rpc`) and `host-actions.ts` (cloud path)
 * can pull it in without a cycle. Same reasoning as `gh.ts`.
 */

import { spawn } from 'node:child_process';
import type { GitRpcResult } from './types.js';

export const HOST_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
const READY_CACHE_TTL_MS = 60_000;

/**
 * Spawn `bin argv` in `cwd` and resolve the standard
 * `{ exitCode, stdout, stderr }` envelope. stdin is ignored (there is no TTY
 * on the other end of an RPC) and output is buffered, so this is for short,
 * non-interactive commands only.
 *
 * Never rejects: a missing binary lands as exit 127, a timeout as exit 124.
 */
export function runHostBinary(
  bin: string,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number = HOST_EXEC_DEFAULT_TIMEOUT_MS,
): Promise<GitRpcResult> {
  return new Promise<GitRpcResult>((resolve) => {
    const child = spawn(bin, [...argv], {
      cwd,
      env: process.env,
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
      stderr += `\nrelay: ${bin} command timed out after ${String(timeoutMs)}ms\n`;
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

interface ReadyCacheEntry {
  /** null on success; ready-to-send error envelope when the binary isn't usable. */
  result: GitRpcResult | null;
  expiresAt: number;
}
const readyCache = new Map<string, ReadyCacheEntry>();

/**
 * Returns `null` when `bin` is on the host's PATH and its version probe
 * succeeds; otherwise a ready-to-send envelope describing what's missing.
 * Cached per binary for ~60s so a burst of tool calls doesn't reprobe on
 * every one (same TTL as `assertGhReady`).
 *
 * - binary missing → exit 127 (matches Bash's "command not found").
 * - binary present but the probe exits non-zero → propagate that exit.
 *
 * Auth state is deliberately NOT probed: an unauthed CLI exits non-zero with
 * its own clear message on the real call, which the relay passes through
 * verbatim. Auth probing is `agentbox doctor`'s job, not the hot path.
 */
export async function assertHostBinReady(
  bin: string,
  versionArgs: readonly string[] = ['--version'],
): Promise<GitRpcResult | null> {
  const now = Date.now();
  const cached = readyCache.get(bin);
  if (cached && cached.expiresAt > now) return cached.result;
  const result = await probeHostBin(bin, versionArgs);
  readyCache.set(bin, { result, expiresAt: now + READY_CACHE_TTL_MS });
  return result;
}

/** Test-only: clear the readiness cache between cases. */
export function _resetHostBinReadyCacheForTests(): void {
  readyCache.clear();
}

async function probeHostBin(
  bin: string,
  versionArgs: readonly string[],
): Promise<GitRpcResult | null> {
  const version = await runHostBinary(bin, versionArgs, process.cwd(), 10_000);
  if (version.exitCode === 127 || /ENOENT/.test(version.stderr)) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: `${bin} is not installed on the host\n`,
    };
  }
  if (version.exitCode !== 0) {
    return {
      exitCode: version.exitCode,
      stdout: '',
      stderr:
        `${bin} ${versionArgs.join(' ')} failed: ` +
        (version.stderr || version.stdout).trimEnd() +
        '\n',
    };
  }
  return null;
}

/**
 * True when `bin` resolves on the host's PATH. Used by `tool.request` to give
 * the box a direct "not installed on the host" answer instead of raising an
 * approval prompt for a binary that could never run.
 */
export async function hostBinExists(bin: string): Promise<boolean> {
  const probe = await runHostBinary('command', ['-v', bin], process.cwd(), 5_000);
  if (probe.exitCode === 0) return true;
  // `command` is a shell builtin on some hosts; fall back to `which`.
  const which = await runHostBinary('which', [bin], process.cwd(), 5_000);
  return which.exitCode === 0;
}
