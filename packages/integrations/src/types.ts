/**
 * Connector descriptor shape for the AgentBox `integrations` foundation —
 * one entry per ticketing/knowledge service the host relay can proxy on
 * behalf of an in-box agent. The descriptors are pure data; the relay
 * (`@agentbox/relay/src/integrations.ts`) does the host-side spawn + write
 * gating, and the ctl (`@agentbox/ctl/src/commands/integration.ts`) builds
 * the in-box command surface from the same descriptors.
 *
 * The same shape mirrors `packages/relay/src/gh.ts`: an allowlist of ops
 * each tagged read/write; reads pass through without prompting, writes go
 * through `askPrompt` before the host CLI is invoked. Anything not on the
 * allowlist is denied by the relay (mirrors `gh api`'s endpoint refusal).
 */

export type IntegrationService = 'notion' | 'linear';

export interface IntegrationOp {
  /** Reads bypass the host confirm prompt; writes always gate via askPrompt. */
  write: boolean;
  /**
   * Optional argv shaper: the ctl forwards user argv verbatim in `args`;
   * `buildArgv` shapes them into the host CLI's argv (e.g.
   * `['page','create', ...args]` for `ntn page create …`). When omitted,
   * the args are forwarded verbatim — useful only for the rare case where
   * the host CLI's command name matches the wire op exactly.
   */
  buildArgv?: (args: readonly string[]) => string[];
  /**
   * Optional inline pre-flight: returned non-null short-circuits the dispatch
   * with the given exit/stderr — used to enforce a stricter contract than
   * `write` alone, e.g. `notion.api` (a `write:false` passthrough) refuses
   * any non-GET HTTP method by parsing `-X`/`--method`/`-f`/`-F` so the
   * "read" classification isn't a hole. Mirrors `refuseGhApiCall` in
   * `packages/relay/src/gh.ts`.
   */
  refuseCall?: (args: readonly string[]) => IntegrationOpRefusal | null;
}

/** Ready-to-send refusal returned by `IntegrationOp.refuseCall`. */
export interface IntegrationOpRefusal {
  /** Conventional CLI exit code (65 = bad usage, etc.); surfaces to the agent. */
  exitCode: number;
  /** One-line `\n`-terminated reason; rendered to the agent's stderr. */
  stderr: string;
}

export interface IntegrationConnector {
  service: IntegrationService;
  /** Host binary the relay execs (resolved on PATH). */
  hostBin: string;
  /**
   * How `agentbox doctor` detects host presence + auth. The relay's
   * `assertIntegrationReady` probe only reads `versionArgs` ("binary
   * present?"); `agentbox doctor` additionally runs `authArgs` ("logged
   * in?") and surfaces `installHint` / `loginHint` to the user when those
   * probes fail. Keeping the hint strings on the descriptor (not in the
   * doctor) means each connector is self-describing — when Linear lands
   * its own descriptor carries its own install URL with no doctor change.
   */
  detect: {
    versionArgs: readonly string[];
    authArgs?: readonly string[];
    installHint?: string;
    loginHint?: string;
  };
  /**
   * Extra env vars the relay forces when spawning the host CLI. For Notion
   * this is `NOTION_KEYRING=0` so `ntn` reads file-based auth on Linux
   * boxes; on the macOS host that env var is harmless (keychain mode is
   * the default and the var only suppresses an alternative path).
   */
  env?: Readonly<Record<string, string>>;
  /** Allowlist of proxied ops; anything not listed is denied at the relay. */
  ops: Readonly<Record<string, IntegrationOp>>;
}
