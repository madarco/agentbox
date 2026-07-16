/**
 * Shared shape for a provider health-check row, produced by each provider's
 * `doctorChecks()` and consumed by `agentbox doctor` / the install wizard, plus
 * the `ProviderModule` contract the CLI loads each `@agentbox/sandbox-<name>`
 * through.
 *
 * Lives in sandbox-core (not apps/cli) so each provider package can own its own
 * probes and login/credential surface without depending on the CLI — a new
 * provider ships all of this in its own package and the CLI dispatches to it
 * generically via a lazy `import()`.
 */

import type { CloudBackend, Provider } from '@agentbox/core';

/**
 * `info` is for rows that are intentionally inert (e.g. an integration the
 * user hasn't enabled). It surfaces as a distinct glyph but rolls up like
 * `ok` so it never pushes the overall doctor status to "warn".
 */
export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail';

export interface CheckResult {
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

/** Normalized credential state used by the install wizard's re-auth prompt. */
export interface CredStatusSummary {
  configured: boolean;
  /** Optional detail shown in the "already configured (…)" line (e.g. auth kind). */
  label?: string;
}

/**
 * Outcome of a non-interactive `setCredentials` call (the headless path the hub
 * drives). `status` reflects the store *after* the attempt, so a caller can
 * report `configured` without a second read.
 */
export interface CredSetResult {
  ok: boolean;
  /** One-line failure reason when `ok` is false (e.g. a rejected token). */
  error?: string;
  status: CredStatusSummary;
}

/**
 * The uniform surface every `@agentbox/sandbox-<name>` package exposes as
 * `export const providerModule`. The CLI's provider loader resolves this via a
 * lazy `import()` and drives create / doctor / install / checkpoint through it,
 * so adding a provider needs no per-provider `switch` arm in the CLI.
 */
export interface ProviderModule {
  /** The `Provider` implementation (lifecycle, exec, attach, checkpoint…). */
  provider: Provider;
  /** Cloud backend (host-side executor). Absent for the local docker provider. */
  backend?: CloudBackend;
  /**
   * First-run credential gate. Called before `create`/`claude`/etc. hand out
   * the provider. Absent for docker (no login). `force` re-runs the flow.
   */
  ensureCredentials?: (opts?: { force?: boolean }) => Promise<void>;
  /** Normalized credential state for the install wizard. Absent for docker. */
  readCredStatus?: () => Promise<CredStatusSummary> | CredStatusSummary;
  /**
   * Non-interactive credential write (the headless path a hub/API driver uses,
   * bypassing the TTY-gated `ensureCredentials` prompts). Validates the given
   * fields against the cloud, then persists them to `~/.agentbox/secrets.env`.
   * The `fields` shape is provider-specific (e.g. `{ apiKey }`, `{ token }`,
   * `{ token, teamId?, projectId? }`). Absent for docker (no login). Never
   * returns the secret values.
   */
  setCredentials?: (fields: Record<string, string>) => Promise<CredSetResult>;
  /**
   * CURRENT build-context fingerprint of the provider's base image/snapshot,
   * for staleness nagging. Absent for docker (its base self-heals).
   */
  currentBaseFingerprintLive?: (
    claudeInstall?: 'native' | 'npm',
  ) => Promise<string | undefined>;
  /** Local, offline-safe health probes for `agentbox doctor`. */
  doctorChecks: () => Promise<CheckResult[]>;
}

/**
 * The `[ ok ]` / `[warn]` / `[FAIL]` / `[info]` badge prefix used by
 * `agentbox doctor`'s detailed report and the `remote-docker doctor` subcommand.
 * Colorless by design — same width per status so labels line up.
 */
export function statusBadge(s: CheckStatus): string {
  if (s === 'ok') return '[ ok ]';
  if (s === 'info') return '[info]';
  if (s === 'warn') return '[warn]';
  return '[FAIL]';
}

/** First line of a multi-line string (for compact error summaries). */
export function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

/** Compact one-line summary of an unknown thrown value. */
export function errSummary(err: unknown): string {
  return err instanceof Error ? firstLine(err.message) : String(err);
}
