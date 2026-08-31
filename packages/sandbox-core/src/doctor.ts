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

import type { ProviderDescriptor } from '@agentbox/config';
import type { CloudBackend, Provider } from '@agentbox/core';
import type { FileManifest } from './prepared-state.js';

/**
 * `info` is for rows that are intentionally inert (e.g. a host tool the
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
   * Declarative metadata — label, credential fields, bake story, capabilities —
   * for UIs and the CLI. Built-in providers declare this in `@agentbox/config`'s
   * `PROVIDERS` table instead; an external plugin declares it here and
   * `agentbox plugin add` snapshots it into `~/.agentbox/plugins.json`.
   *
   * OPTIONAL, and safe to omit: a plugin without one gets a descriptor derived
   * from this module plus defaults chosen to reproduce pre-descriptor behavior
   * (see `provider-descriptor.ts`). Declaring one buys a real label, a credential
   * form, and correct SSH / pause / VNC gating.
   */
  descriptor?: ProviderDescriptor;
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
  currentBaseFingerprintLive?: (agentInstall?: 'native' | 'npm') => Promise<string | undefined>;
  /**
   * Per-file digests behind that fingerprint (relpath → sha256), so a `stale`
   * verdict can be explained rather than only asserted. Diffed against the
   * manifest stored at bake time.
   *
   * Each provider resolves its OWN asset list, which is why this is a
   * per-provider hook and not a shared helper — docker hashes
   * `DOCKER_CONTEXT_FILE_MAP`, the cloud providers each hash their own
   * `resolveRuntimeAssets()`. `undefined` when the assets can't be resolved.
   */
  currentBaseFileHashes?: () => Promise<FileManifest | undefined>;
  /**
   * Reason `size` won't take effect, or `null` if it will.
   *
   * Some backends fix CPU/memory/disk when the base image is BAKED and reject
   * per-create resources (daytona on the snapshot path, e2b always), so a
   * `--size` / `box.size<Provider>` there is silently discarded at provision.
   * The CLI calls this early — on `config set` and before a create is queued —
   * so the warning reaches a terminal instead of only a detached job's log.
   *
   * Per-provider rather than shared for the same reason as
   * `currentBaseFileHashes` above: each parses its own size grammar
   * (`cpu-mem-disk` vs `cpu-mem`) and reads the baked value from its own
   * prepared-state shape. Must stay PURE and LOCAL — no network, no
   * credentials — because it runs on every `agentbox config set box.size…`.
   * Absent for backends that apply size live (hetzner, vercel, docker).
   */
  sizeIgnoredReason?: (size: string) => string | null;
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
