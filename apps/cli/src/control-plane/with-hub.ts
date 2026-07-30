/**
 * `withHubClient` — the one entry point CLI commands use to run an operation
 * against the hub's `/api/v1`, in BOTH modes (a local hub or a remote control
 * box; the only difference is the base URL + token, resolved by
 * `resolveHubApiTarget`). It:
 *
 *   1. resolves the client (auto-starting a local hub when needed),
 *   2. gates the hub's `/api/v1` version once up front — a hub outside
 *      {@link SUPPORTED_HUB_API_VERSIONS} is refused with an upgrade hint rather
 *      than failing on a changed field mid-operation,
 *   3. runs the caller's op, and
 *   4. maps a {@link HubApiError} (or an unreachable hub) to a stable CLI exit
 *      code + an actionable message.
 *
 * Later steps of the `/api/v1` consolidation are then a mechanical conversion:
 * wrap the op body in `withHubClient` and delete the inline provider code. A
 * command that needs to special-case a code (e.g. treat `not_found` as info)
 * catches it inside its own callback before it reaches the mapper here.
 */
import { log } from '@clack/prompts';
import type { HubTarget } from '../commands/hub.js';
import { HubApiClient, HubApiError, SUPPORTED_HUB_API_VERSIONS } from './hub-api-client.js';

export interface WithHubOptions {
  /** Override the hub URL (default: the configured control box, else the local hub). */
  url?: string;
  /**
   * Prefer the hub on THIS machine even when a remote control box is configured
   * (the which-hub principle, Step 1). A docker box is always local-owned, so a
   * docker op sets this to avoid hitting a remote hub that never owned it (it
   * would answer `not_found`). Reuses Step 0's exposed-loopback-first ladder.
   */
  preferLocal?: boolean;
}

/** True when the hub's reported `apiVersion` is one this CLI speaks. */
export function isSupportedApiVersion(version: string | undefined): boolean {
  return (
    version !== undefined && (SUPPORTED_HUB_API_VERSIONS as readonly string[]).includes(version)
  );
}

// Distinct exit codes per API error class, so scripts can branch on the failure
// kind. `not_found` reuses 2 to match the lifecycle-error convention
// (`handleLifecycleError`). Anything unmapped (including `internal`) is a plain 1.
const EXIT_BY_CODE: Record<string, number> = {
  not_found: 2,
  unauthorized: 3,
  invalid_request: 4,
  conflict: 5,
  backend_unavailable: 6,
};

/** The CLI exit code for a hub `/api/v1` error code. */
export function exitCodeForApiError(code: string): number {
  return EXIT_BY_CODE[code] ?? 1;
}

/**
 * The exit code to report for a hub error. A carried `details.exitCode` (a box
 * command's own exit — e.g. 64 for `git push --host-only` with no host checkout)
 * wins, so the CLI surfaces the box's faithful exit rather than the coarse
 * code→exit mapping. Falls back to the per-code table otherwise.
 */
function exitCodeForHubError(err: HubApiError): number {
  const carried = (err.details as { exitCode?: unknown } | undefined)?.exitCode;
  if (typeof carried === 'number' && Number.isInteger(carried) && carried > 0) return carried;
  return exitCodeForApiError(err.code);
}

/** An extra actionable line for the error classes where the raw message isn't enough. */
function hintForApiError(err: HubApiError): string | null {
  switch (err.code) {
    case 'unauthorized':
      return 'The hub rejected the API token. Restart a local hub with `agentbox hub restart`, or check AGENTBOX_HUB_API_KEY for a remote control box.';
    case 'backend_unavailable':
      return "The hub reached its backend but it was unavailable — the provider or host it needs may not be configured on the hub's machine.";
    default:
      return null;
  }
}

/**
 * Map a resolved {@link HubTarget} to the `/api/v1` client target, or the reason
 * it can't be used. Pure — the local⇄remote logic lives in `resolveHubTarget`;
 * this only converts `token`→`apiKey` and decides whether a token is present.
 * The token IS the Bearer for both modes (a local hub's token, or a control
 * box's `AGENTBOX_HUB_API_KEY`).
 */
export function hubApiTargetFrom(
  target: HubTarget,
):
  | { ok: true; url: string; apiKey: string }
  | { ok: false; reason: 'no-token'; mode: 'local' | 'remote' } {
  if (!target.token) return { ok: false, reason: 'no-token', mode: target.mode };
  return { ok: true, url: target.url, apiKey: target.token };
}

/** Print a hub failure and set the matching exit code. Never throws. */
function reportHubError(err: unknown, url: string): void {
  if (err instanceof HubApiError) {
    log.error(err.message);
    const hint = hintForApiError(err);
    if (hint) log.info(hint);
    process.exitCode = exitCodeForHubError(err);
    return;
  }
  // A fetch/network failure (hub down, wrong URL) surfaces as a plain Error.
  log.error(`Can't reach the hub at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

export async function withHubClient<T>(
  opts: WithHubOptions,
  fn: (client: HubApiClient) => Promise<T>,
): Promise<T | undefined> {
  // Lazy import breaks the hub.ts <-> control-plane.ts module cycle that both of
  // those already sit in (hub.ts consumes control-plane.ts's command list at
  // load time). Cheap after the first call — the module is cached.
  const { resolveHubApiTarget } = await import('../commands/control-plane.js');
  const target = await resolveHubApiTarget(opts.url, { preferLocal: opts.preferLocal });
  if (!target) {
    // resolveHubApiTarget already printed an actionable error (missing config /
    // key, or a local-hub autostart failure).
    process.exitCode = 1;
    return undefined;
  }
  const client = new HubApiClient(target);

  // Version gate — also the first authed-adjacent round-trip, so an unreachable
  // hub is reported here rather than surfacing later as a confusing op failure.
  try {
    const health = await client.health();
    if (!isSupportedApiVersion(health.apiVersion)) {
      log.error(
        `The hub at ${target.url} serves API ${health.apiVersion ? `"${health.apiVersion}"` : '(none reported)'}, ` +
          `which this CLI doesn't support (needs ${SUPPORTED_HUB_API_VERSIONS.join(', ')}).`,
      );
      log.info(
        'Upgrade it (`agentbox hub update` for a remote control box, or `agentbox hub restart` for a local hub) or update this CLI to match.',
      );
      process.exitCode = 1;
      return undefined;
    }
  } catch (err) {
    if (err instanceof HubApiError) {
      // A hub too old to expose /api/v1 answers the probe with an error envelope.
      log.error(
        `The hub at ${target.url} didn't answer the /api/v1 health probe (${err.code}). It may be too old — upgrade it.`,
      );
      process.exitCode = 1;
    } else {
      reportHubError(err, target.url);
    }
    return undefined;
  }

  try {
    return await fn(client);
  } catch (err) {
    reportHubError(err, target.url);
    return undefined;
  }
}

/**
 * Whether the hub that OWNS this box runs on THIS machine — the `preferLocal`
 * answer for any box op. **The one ownership predicate**: a lifecycle/destroy op
 * can only be served by the hub that owns the box, and getting this wrong sends
 * the op to a hub that never registered the box (→ `not_found`). True for the
 * provider families the LOCAL hub drives directly:
 *   - `docker` — a container on this machine.
 *   - `remote-docker` — a container on another machine's engine, but the box
 *     registers with the LOCAL relay (the local hub drives the remote engine over
 *     SSH), so its owner is still local.
 * Cloud providers (e2b/vercel/hetzner/daytona/digitalocean) are owned by whichever
 * hub is configured, so they are NOT local-owned. Every caller MUST use this rather
 * than an inline `provider === 'docker'` check — five copies drift; a new provider
 * is classified here once.
 */
export function boxOwningHubIsLocal(box: { provider?: string }): boolean {
  const p = box.provider ?? 'docker';
  return p === 'docker' || p === 'remote-docker';
}

/** The outcome of a box op routed to its owning hub (see {@link withOwningHub}). */
export type OwningHubOutcome = 'ok' | 'not-found' | undefined;

/**
 * Run a box op against the hub that OWNS the box (local for docker/remote-docker,
 * the configured hub for cloud — see {@link boxOwningHubIsLocal}), retrying the
 * OTHER distinct hub on `not_found`. A box can legitimately be unknown to the
 * first hub — e.g. a docker box whose op reached a configured remote hub that
 * never owned it — so a single `not_found` is not proof it belongs to no hub.
 * Returns:
 *   - `'ok'`        — some hub performed the op.
 *   - `'not-found'` — no hub AgentBox knows owns the box.
 *   - `undefined`   — a hub error other than not_found (the owner-first attempt
 *                     went through {@link withHubClient}, which already reported it
 *                     + set the exit code).
 */
export async function withOwningHub(
  box: { id: string; provider?: string },
  op: (client: HubApiClient) => Promise<void>,
): Promise<OwningHubOutcome> {
  const ownerLocal = boxOwningHubIsLocal(box);
  const primary = await withHubClient({ preferLocal: ownerLocal }, async (client) => {
    try {
      await op(client);
      return 'ok' as const;
    } catch (err) {
      if (err instanceof HubApiError && err.code === 'not_found') return 'not-found' as const;
      throw err;
    }
  });
  if (primary === undefined) return undefined; // withHubClient reported + set the exit code
  if (primary === 'ok') return 'ok';
  // The owner-first hub does not know this box. Retry the OTHER distinct hub.
  const other = await runOpOnOtherHub(box, op, !ownerLocal);
  if (other === 'ok') return 'ok';
  if (other === 'error') return undefined; // a real error on the retry hub — already reported
  return 'not-found';
}

/**
 * Run the op against the OTHER hub (the one `preferLocalOther` selects), skipped
 * when it resolves to the same URL as the owner-first attempt (a pure-local setup
 * has only one hub). Distinguishes three outcomes so a REAL error on the retry hub
 * isn't misreported as "no hub owns the box":
 *   - `'ok'`        — the retry hub performed the op.
 *   - `'error'`     — a genuine failure (conflict / auth / provider error); it is
 *                     REPORTED here (message + exit code) and the caller aborts.
 *   - `'not-found'` — the retry hub doesn't own the box (`not_found`), OR it was
 *                     unreachable / unresolvable — neither is proof of ownership,
 *                     so the caller treats the box as owned by no known hub.
 */
async function runOpOnOtherHub(
  box: { id: string; provider?: string },
  op: (client: HubApiClient) => Promise<void>,
  preferLocalOther: boolean,
): Promise<'ok' | 'error' | 'not-found'> {
  let owner: { url: string; apiKey: string } | null;
  let other: { url: string; apiKey: string } | null;
  try {
    const { resolveHubApiTarget } = await import('../commands/control-plane.js');
    [owner, other] = await Promise.all([
      resolveHubApiTarget(undefined, { quiet: true, preferLocal: !preferLocalOther }),
      // Non-quiet so a stopped LOCAL retry hub is auto-started (it's a candidate owner).
      resolveHubApiTarget(undefined, { preferLocal: preferLocalOther }),
    ]);
  } catch {
    return 'not-found'; // couldn't even resolve the other hub — not proof of ownership
  }
  if (!other) return 'not-found';
  if (owner && owner.url === other.url) return 'not-found'; // no distinct second hub
  try {
    await op(new HubApiClient(other));
    return 'ok';
  } catch (err) {
    if (err instanceof HubApiError) {
      // `not_found` = legitimately not owned here; any other code (conflict, auth,
      // backend, internal) is a REAL failure to surface, NOT "no hub owns the box".
      if (err.code === 'not_found') return 'not-found';
      reportHubError(err, other.url);
      return 'error';
    }
    // A network/transport failure to the second hub — unreachable is not proof of
    // ownership, so preserve the box (the caller keeps its record / refuses).
    return 'not-found';
  }
}

/**
 * Report a box that no hub AgentBox knows about owns, for the lifecycle commands
 * (start/stop/pause/unpause). Sets the `not_found` exit code (2). `destroy` does
 * NOT use this — it keeps the local record and names `--force` instead, because
 * dropping the record of a possibly-still-running resource is the dangerous case.
 */
export function reportBoxNotOnAnyHub(box: { name: string }): void {
  log.error(`Box ${box.name} was not found on any hub AgentBox knows.`);
  log.info('Run `agentbox ls` to see boxes AgentBox can drive.');
  process.exitCode = 2;
}
