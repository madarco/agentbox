/**
 * CLI-side wrapper over the shared model-auth gate.
 *
 * The decision (flag > config > ask) lives in `@agentbox/sandbox-core` so the
 * hub can run it for a tray/web create. What stays here is the CLI's context:
 * where "the user set this explicitly" comes from, and a terminal asker that
 * declines on a non-TTY.
 */

import { modelAuthSourceId, type AgentSettings, type AgentSyncSpec } from '@agentbox/core';
import type { ConfigSource } from '@agentbox/config';
import {
  MODEL_AUTH_NONE,
  MODEL_AUTH_SETTING,
  resolveModelAuth as resolveSharedModelAuth,
  type AvailableSource,
} from '@agentbox/sandbox-core';
import { clackAsker } from './ask-clack.js';

export { MODEL_AUTH_NONE, MODEL_AUTH_SETTING };

export interface ModelAuthGateArgs {
  spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>;
  /** `--model-auth <source...>` as typed, if passed. Repeatable and comma-splitting. */
  flags?: readonly string[];
  /** The agent's settings block, defaults applied. */
  settings: AgentSettings;
  /** Where each leaf came from; `default` means the user set nothing. */
  sources: Record<string, ConfigSource>;
  yes?: boolean;
  isTTY?: boolean;
  /** Injectable for tests: which sources this host can satisfy. */
  listAvailable?: (spec: ModelAuthGateArgs['spec']) => Promise<AvailableSource[]>;
}

/**
 * Help for `--model-auth`, rendered from the row so the text cannot drift from
 * the data. Lives here rather than in the service-command factory because every
 * agent that declares sources gets the flag now, not only a service one.
 */
export function modelAuthHelp(spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>): string {
  const sources = spec.modelAuth?.sources ?? [];
  if (sources.length === 0) return `not applicable: ${spec.id} uses no host login`;
  const values = ['none', ...sources.map((s) => modelAuthSourceId(s))].join('|');
  return (
    `which host model-provider logins to seed (${values}; repeatable or comma-separated; ` +
    `default: ${spec.id}.${MODEL_AUTH_SETTING}, else ask). ` +
    sources.map((s) => `${modelAuthSourceId(s)}: ${s.label}`).join('; ')
  );
}

/** The model-auth sources the create should seed, in declaration order. */
export async function resolveModelAuth(args: ModelAuthGateArgs): Promise<string[]> {
  const tty = args.isTTY ?? process.stdin.isTTY;
  return resolveSharedModelAuth({
    spec: args.spec,
    ...(args.flags !== undefined ? { flags: args.flags } : {}),
    settings: args.settings,
    configuredExplicitly:
      (args.sources[`${args.spec.id}.${MODEL_AUTH_SETTING}`] ?? 'default') !== 'default',
    // `-y` and a non-TTY both mean "don't ask", and the prompt's own fallback
    // decides what that yields: a login FILE is declined, provider API keys the
    // host already exports are kept. So a scripted create never silently gains
    // a subscription token, and never silently loses a key it has today.
    ask: clackAsker({ isTTY: !args.yes && !!tty }),
    ...(args.listAvailable ? { listAvailable: args.listAvailable } : {}),
  });
}
