/**
 * The create-time decision "which host login does this service box borrow as
 * its model provider?" — the host-boundary gate for `AgentSyncSpec.modelAuth`.
 *
 * Precedence: `--model-auth` > the agent's `<agent>.modelAuth` config key >
 * a prompt. The prompt only appears when nothing chose, stdin is a TTY, the
 * host actually holds one of the declared logins, and `--yes` was not passed —
 * so a scripted create never hands a subscription token to a daemon by
 * default. Declining, `--yes` and a non-TTY all resolve to "none", which is
 * also the config default: a box that comes up without model auth says so in
 * its ingest task's log, it does not fail.
 */

import { confirm, isCancel, log } from '@clack/prompts';
import type { AgentSyncSpec, AgentSettings } from '@agentbox/core';
import type { ConfigSource } from '@agentbox/config';
import { resolveBorrowedCredentials, resolveHostCredentialFile } from '@agentbox/sandbox-core';

export const MODEL_AUTH_SETTING = 'modelAuth';
export const MODEL_AUTH_NONE = 'none';

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
  /** Injectable for tests: does the host hold a usable login for this agent? */
  hostHasLogin?: (agent: string) => Promise<boolean>;
  /** Injectable for tests: the prompt. */
  ask?: (message: string) => Promise<boolean>;
}

/** The agents whose logins the create should seed, in declaration order. */
export async function resolveModelAuth(args: ModelAuthGateArgs): Promise<string[]> {
  const { spec } = args;
  const borrows = spec.modelAuth?.borrows ?? [];
  if (borrows.length === 0) {
    if (args.flag !== undefined && args.flag !== MODEL_AUTH_NONE) {
      throw new Error(`${spec.id} borrows no host login — --model-auth does not apply to it`);
    }
    return [];
  }

  const flag = args.flag?.trim();
  if (flag !== undefined) {
    return flag === MODEL_AUTH_NONE ? [] : resolveBorrowedCredentials(spec, [flag]);
  }

  const configured = args.settings[MODEL_AUTH_SETTING];
  const explicit = (args.sources[`${spec.id}.${MODEL_AUTH_SETTING}`] ?? 'default') !== 'default';
  if (explicit || (typeof configured === 'string' && configured !== MODEL_AUTH_NONE)) {
    return typeof configured === 'string' && configured !== MODEL_AUTH_NONE
      ? resolveBorrowedCredentials(spec, [configured])
      : [];
  }

  if (args.yes || !(args.isTTY ?? process.stdin.isTTY)) return [];

  const hasLogin =
    args.hostHasLogin ??
    (async (agent: string) => (await resolveHostCredentialFile(agent)) !== null);
  const ask =
    args.ask ??
    (async (message: string) => {
      const answer = await confirm({ message, initialValue: false });
      return !isCancel(answer) && answer === true;
    });
  const chosen: string[] = [];
  for (const b of borrows) {
    if (!(await hasLogin(b.agent))) continue;
    if (b.caveat) log.warn(b.caveat);
    const yes = await ask(
      `Seed this ${spec.id} box with ${b.label} as its model provider? (--model-auth ${b.agent}, or \`agentbox config set ${spec.id}.${MODEL_AUTH_SETTING} ${b.agent}\` to stop asking)`,
    );
    if (yes) chosen.push(b.agent);
  }
  return resolveBorrowedCredentials(spec, chosen);
}
