/**
 * CLI-side wrapper over the shared model-auth gate.
 *
 * The decision (flag > config > ask) lives in `@agentbox/sandbox-core` so the
 * hub can run it for a tray/web create. What stays here is the CLI's context:
 * where "the user set this explicitly" comes from, and a terminal asker that
 * declines on a non-TTY.
 */

import type { AgentSettings, AgentSyncSpec } from '@agentbox/core';
import type { ConfigSource } from '@agentbox/config';
import {
  MODEL_AUTH_NONE,
  MODEL_AUTH_SETTING,
  resolveModelAuth as resolveSharedModelAuth,
  type AvailableBorrow,
} from '@agentbox/sandbox-core';
import { clackAsker } from './ask-clack.js';

export { MODEL_AUTH_NONE, MODEL_AUTH_SETTING };

export interface ModelAuthGateArgs {
  spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>;
  /** `--model-auth <source>` as typed, if passed. */
  flag?: string;
  /** The agent's settings block, defaults applied. */
  settings: AgentSettings;
  /** Where each leaf came from; `default` means the user set nothing. */
  sources: Record<string, ConfigSource>;
  yes?: boolean;
  isTTY?: boolean;
  /** Injectable for tests: which borrows this host can satisfy. */
  listAvailable?: (spec: ModelAuthGateArgs['spec']) => Promise<AvailableBorrow[]>;
}

/** The agents whose logins the create should seed, in declaration order. */
export async function resolveModelAuth(args: ModelAuthGateArgs): Promise<string[]> {
  const tty = args.isTTY ?? process.stdin.isTTY;
  return resolveSharedModelAuth({
    spec: args.spec,
    ...(args.flag !== undefined ? { flag: args.flag } : {}),
    settings: args.settings,
    configuredExplicitly:
      (args.sources[`${args.spec.id}.${MODEL_AUTH_SETTING}`] ?? 'default') !== 'default',
    // `-y` and a non-TTY both mean "don't ask" — the asker's fallback is
    // `none`, which is also the config default, so the box comes up without
    // model auth rather than silently holding a subscription token.
    ask: clackAsker({ isTTY: !args.yes && !!tty }),
    ...(args.listAvailable ? { listAvailable: args.listAvailable } : {}),
  });
}
