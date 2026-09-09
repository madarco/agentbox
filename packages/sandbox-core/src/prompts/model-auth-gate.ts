/**
 * The create-time decision "which host login does this service box borrow as its
 * model provider?" — the host-boundary gate for `AgentSyncSpec.modelAuth`.
 *
 * Precedence: `--model-auth` > the agent's `<agent>.modelAuth` config key > a
 * prompt. The prompt only appears when nothing chose and the host actually holds
 * one of the declared logins, so a scripted create never hands a subscription
 * token to a daemon by default. Declining resolves to "none", which is also the
 * config default: a box that comes up without model auth says so in its ingest
 * task's log, it does not fail.
 *
 * Like the carry gate, it asks through a {@link PromptAsker} rather than a
 * prompt library, so the hub can ask the same question of a tray or web client.
 */

import {
  promptId,
  type AgentSettings,
  type AgentSyncSpec,
  type PromptAsker,
  type PromptChoice,
  type PromptRequest,
} from '@agentbox/core';
import { resolveBorrowedCredentials } from '../borrowed-credentials.js';
import { resolveHostCredentialFile } from '../sync/concerns/credentials.js';

export const MODEL_AUTH_TOPIC = 'model-auth';
export const MODEL_AUTH_SETTING = 'modelAuth';
export const MODEL_AUTH_NONE = 'none';

/** A borrow the host can actually satisfy, with the paths to show the user. */
export interface AvailableBorrow {
  agent: string;
  label: string;
  caveat?: string;
  /** Where the login is on this host. */
  hostPath: string;
  /** Where it lands inside the box. */
  boxPath: string;
  bytes?: number;
}

export interface ModelAuthGateArgs {
  spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>;
  /** `--model-auth <source>` as typed, if passed. */
  flag?: string;
  /** The agent's settings block, defaults applied. */
  settings: AgentSettings;
  /** True when `<agent>.modelAuth` was set by the user rather than defaulted. */
  configuredExplicitly: boolean;
  ask: PromptAsker;
  /** Injectable for tests: which borrows this host can satisfy. */
  listAvailable?: (spec: ModelAuthGateArgs['spec']) => Promise<AvailableBorrow[]>;
}

/**
 * Build the question for a set of satisfiable borrows.
 *
 * One `select` rather than a confirm per borrow: `<agent>.modelAuth` is itself a
 * single-valued enum, so offering more than one choice at a time would let the
 * prompt express something the config cannot.
 */
export function buildModelAuthPrompt(agentId: string, available: AvailableBorrow[]): PromptRequest {
  const choices: PromptChoice[] = [
    {
      value: MODEL_AUTH_NONE,
      label: 'No model auth',
      hint: `configure it inside the box (or \`agentbox config set ${agentId}.${MODEL_AUTH_SETTING} <agent>\`)`,
    },
    ...available.map((b) => ({
      value: b.agent,
      label: b.label,
      ...(b.caveat ? { hint: b.caveat } : {}),
      // Copying a subscription login into a long-lived daemon is the weightier
      // of the two options, and should not look like the calm default.
      danger: true,
    })),
  ];
  const first = available[0];
  return {
    id: promptId(MODEL_AUTH_TOPIC, {
      agent: agentId,
      borrows: available.map((b) => ({ agent: b.agent, hostPath: b.hostPath })),
    }),
    topic: MODEL_AUTH_TOPIC,
    kind: 'select',
    title: `Seed this ${agentId} box with a model provider login?`,
    body:
      `${agentId} runs as a daemon and needs a model provider. It can start from a ` +
      'login you already hold on this host — a copy is placed in the box, which ' +
      'refreshes it independently from then on.',
    choices,
    defaultValue: MODEL_AUTH_NONE,
    ...(first
      ? {
          detail: {
            type: 'credential' as const,
            summary: `${first.hostPath} -> ${first.boxPath}`,
            agent: first.agent,
            label: first.label,
            ...(first.caveat ? { caveat: first.caveat } : {}),
            hostPath: first.hostPath,
            boxPath: first.boxPath,
            ...(first.bytes !== undefined ? { bytes: first.bytes } : {}),
          },
        }
      : {}),
    // Declining is the safe answer and the config default, so an asker that
    // cannot reach a human takes it rather than refusing the create.
    fallback: { value: MODEL_AUTH_NONE, reason: 'not asked; starting without model auth' },
    nonInteractiveHint:
      `Pass --model-auth <agent|none>, or \`agentbox config set ${agentId}.${MODEL_AUTH_SETTING} <agent>\` ` +
      'to decide this up front.',
  };
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
  if (
    args.configuredExplicitly ||
    (typeof configured === 'string' && configured !== MODEL_AUTH_NONE)
  ) {
    return typeof configured === 'string' && configured !== MODEL_AUTH_NONE
      ? resolveBorrowedCredentials(spec, [configured])
      : [];
  }

  const available = await (args.listAvailable ?? listAvailableBorrows)(spec);
  // Nothing to offer: the host holds none of the declared logins.
  if (available.length === 0) return [];

  const answer = await args.ask(buildModelAuthPrompt(spec.id, available));
  if (answer.cancelled) return [];
  const chosen = answer.value;
  if (chosen === MODEL_AUTH_NONE || chosen.length === 0) return [];
  // An answer naming a borrow this host cannot satisfy is a stale answer, not a
  // silent "none" — resolveBorrowedCredentials throws with the valid values.
  return resolveBorrowedCredentials(spec, [chosen]);
}

/** Which declared borrows this host can actually satisfy right now. */
export async function listAvailableBorrows(
  spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>,
): Promise<AvailableBorrow[]> {
  const { findAgentSpec } = await import('@agentbox/agent-registry');
  const out: AvailableBorrow[] = [];
  for (const b of spec.modelAuth?.borrows ?? []) {
    const hit = await resolveHostCredentialFile(b.agent);
    if (!hit) continue;
    const boxPath = findAgentSpec(b.agent)?.credential?.boxAbsPath ?? '';
    out.push({
      agent: b.agent,
      label: b.label,
      ...(b.caveat ? { caveat: b.caveat } : {}),
      hostPath: hit.path,
      boxPath,
      bytes: Buffer.byteLength(hit.text, 'utf8'),
    });
  }
  return out;
}
