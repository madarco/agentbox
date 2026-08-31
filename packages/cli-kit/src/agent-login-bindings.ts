/**
 * What a guided login needs from an agent, and nothing about WHICH agents exist.
 *
 * This file used to hold three `<agent>LoginBinding` functions and import each
 * agent's login spec and docker helpers — a per-agent table in shared code, and
 * the last import edge pointing from the shared CLI INTO the agents. Each of
 * those three had exactly one caller: that agent's own runtime, which already
 * exposes the binding through `AgentRuntime.loginBinding`. So the seam was
 * already there; the functions were simply on the wrong side of it.
 *
 * They live beside their runtimes now (`agents/<id>/login-binding.ts`, moving
 * into `packages/agent-<id>/` with the rest of the CLI layer). What is left here
 * is the contract both `guided-login.ts` and the command descriptor refer to by
 * type only.
 */
import type { AgentLoginSpec } from './agent-login-specs.js';

export interface AgentLoginBinding {
  spec: AgentLoginSpec;
  dockerArgv: string[];
  /** True once the login actually wrote credentials into the volume. */
  verify: () => Promise<boolean>;
  /** Post-success work, e.g. claude's warm-up + host-backup sync. */
  finalize?: () => Promise<{ warmed?: boolean }>;
}

/** An agent's own defaults apply when the user passed no extra args. */
export function withLoginDefaults(spec: AgentLoginSpec, extraArgs: string[]): string[] {
  return extraArgs.length > 0 ? extraArgs : spec.defaultArgs;
}
