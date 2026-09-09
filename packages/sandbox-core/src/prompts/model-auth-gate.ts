/**
 * The create-time decision "which of the host's model-provider logins does this
 * box get?" — the host-boundary gate for `AgentSyncSpec.modelAuth`.
 *
 * Precedence: `--model-auth` > the agent's `<agent>.modelAuth` config key > a
 * prompt. The prompt only offers what the host can actually satisfy right now,
 * so a scripted create never hands out a login by surprise.
 *
 * Two kinds of source share one picker. An `agent` source is another agent's
 * login FILE and is opt-IN: copying a subscription login into a box should never
 * be the answer you get by not reading. An `env` source is a provider API key
 * from the host environment and is opt-OUT, because that key is already
 * forwarded into every box today — making it a grant is about making it visible
 * and revocable, not about taking it away.
 *
 * Like the carry gate, it asks through a {@link PromptAsker} rather than a
 * prompt library, so the hub can ask the same question of a tray or web client.
 */

import {
  decodeMultiAnswer,
  modelAuthSourceId,
  promptId,
  type AgentModelAuthSource,
  type AgentSettings,
  type AgentSyncSpec,
  type PromptAsker,
  type PromptChoice,
  type PromptCredentialRow,
  type PromptRequest,
} from '@agentbox/core';
import { resolveModelAuthSources } from '../borrowed-credentials.js';
import { resolveHostCredentialFile } from '../sync/concerns/credentials.js';

export const MODEL_AUTH_TOPIC = 'model-auth';
export const MODEL_AUTH_SETTING = 'modelAuth';
export const MODEL_AUTH_NONE = 'none';

/** A declared source the host can actually satisfy, with what to show the user. */
export interface AvailableSource {
  /** The stable source id — `codex`, `env:XAI_API_KEY`. */
  id: string;
  kind: 'agent' | 'env';
  label: string;
  provider?: string;
  caveat?: string;
  /** `agent` sources only: where the login is, and where it lands. */
  hostPath?: string;
  boxPath?: string;
  bytes?: number;
  /** `env` sources only: the variable name. Never its value. */
  envVar?: string;
}

export interface ModelAuthGateArgs {
  spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>;
  /** `--model-auth <source...>` as typed, if passed. */
  flags?: readonly string[];
  /** The agent's settings block, defaults applied. */
  settings: AgentSettings;
  /** True when `<agent>.modelAuth` was set by the user rather than defaulted. */
  configuredExplicitly: boolean;
  ask: PromptAsker;
  /** Injectable for tests: which sources this host can satisfy. */
  listAvailable?: (spec: ModelAuthGateArgs['spec']) => Promise<AvailableSource[]>;
}

function detailRow(s: AvailableSource): PromptCredentialRow {
  return {
    value: s.id,
    source: s.kind === 'agent' ? 'file' : 'env',
    label: s.label,
    ...(s.provider ? { provider: s.provider } : {}),
    ...(s.caveat ? { caveat: s.caveat } : {}),
    ...(s.hostPath ? { hostPath: s.hostPath } : {}),
    ...(s.boxPath ? { boxPath: s.boxPath } : {}),
    ...(s.bytes !== undefined ? { bytes: s.bytes } : {}),
    ...(s.envVar ? { envVar: s.envVar } : {}),
  };
}

/** The plain-text rendering a client that does not know `credential-list` shows. */
function listSummary(available: readonly AvailableSource[]): string {
  return available
    .map((s) =>
      s.kind === 'agent'
        ? `${s.label}\n  ${s.hostPath ?? ''} -> ${s.boxPath ?? ''}`
        : `${s.label}\n  ${s.envVar ?? ''}${s.provider ? ` (${s.provider})` : ''}`,
    )
    .join('\n');
}

/**
 * Build the question for a set of satisfiable sources.
 *
 * One shape: a LIST of the logins the host can actually lend, plus "None", and
 * exactly one pick. Not a yes/no, because that only reads correctly while there
 * is one source to say yes TO — and not a multi-select, because a box runs on
 * one model provider. `multiple` stays in the schema for a prompt that genuinely
 * wants several; this one does not.
 *
 * Declining is the default: copying a subscription login into a box should
 * never be the answer you get by not reading.
 */
export function buildModelAuthPrompt(agentId: string, available: AvailableSource[]): PromptRequest {
  const id = promptId(MODEL_AUTH_TOPIC, {
    agent: agentId,
    sources: available.map((s) => ({ id: s.id, hostPath: s.hostPath, envVar: s.envVar })),
  });
  const choices: PromptChoice[] = [
    ...available.map((s) => ({
      value: s.id,
      label: s.label,
      ...((s.caveat ?? s.provider) ? { hint: s.caveat ?? s.provider } : {}),
    })),
    { value: MODEL_AUTH_NONE, label: 'None' },
  ];
  const first = available[0];
  return {
    id,
    topic: MODEL_AUTH_TOPIC,
    kind: 'select',
    heading: 'Model provider',
    title: 'Which login should this box use as its model provider?',
    choices,
    defaultValue: MODEL_AUTH_NONE,
    // One `agent` source still gets the richer single-credential card, which
    // every shipped client already draws properly. Several get the list, whose
    // `summary` is what an older client falls back to.
    detail:
      available.length === 1 && first?.kind === 'agent'
        ? {
            type: 'credential' as const,
            summary: `${first.hostPath ?? ''} -> ${first.boxPath ?? ''}`,
            agent: first.id,
            label: first.label,
            ...(first.caveat ? { caveat: first.caveat } : {}),
            hostPath: first.hostPath ?? '',
            boxPath: first.boxPath ?? '',
            ...(first.bytes !== undefined ? { bytes: first.bytes } : {}),
          }
        : {
            type: 'credential-list' as const,
            summary: listSummary(available),
            rows: available.map(detailRow),
          },
    fallback: { value: MODEL_AUTH_NONE, reason: 'not asked - the box starts without it' },
    nonInteractiveHint:
      `Use --model-auth <source|none>, or \`agentbox config set ${agentId}.${MODEL_AUTH_SETTING} <source>\` ` +
      'to decide this once.',
  };
}

/** Parse a flag / config value into source ids. `none` is only legal alone. */
export function parseModelAuthValue(raw: readonly string[] | string): string[] {
  const parts = (typeof raw === 'string' ? [raw] : raw).flatMap((v) => decodeMultiAnswer(v));
  if (parts.length === 0) return [];
  if (parts.includes(MODEL_AUTH_NONE)) {
    if (parts.length > 1) {
      throw new Error(
        `--model-auth ${MODEL_AUTH_NONE} cannot be combined with ${parts
          .filter((p) => p !== MODEL_AUTH_NONE)
          .join(', ')}`,
      );
    }
    return [];
  }
  return parts;
}

/** The model-auth sources this create should seed, in declaration order. */
export async function resolveModelAuth(args: ModelAuthGateArgs): Promise<string[]> {
  const { spec } = args;
  const sources = spec.modelAuth?.sources ?? [];
  if (sources.length === 0) {
    if (args.flags !== undefined && parseModelAuthValue(args.flags).length > 0) {
      throw new Error(`${spec.id} uses no host login — --model-auth does not apply to it`);
    }
    return [];
  }

  if (args.flags !== undefined) {
    return resolveModelAuthSources(spec, parseModelAuthValue(args.flags));
  }

  const configured = args.settings[MODEL_AUTH_SETTING];
  const configuredIds = typeof configured === 'string' ? parseModelAuthValue(configured) : [];
  if (args.configuredExplicitly || configuredIds.length > 0) {
    return resolveModelAuthSources(spec, configuredIds);
  }

  // Asking is opt-in per row. A coding agent has its own sign-in and usually
  // its own login, so a question on every create would be noise; it is still
  // fully drivable by `--model-auth` and the config key above.
  if (!spec.modelAuth?.promptOnCreate) return [];

  const available = await (args.listAvailable ?? listAvailableSources)(spec);
  // Nothing to offer: the host holds none of the declared logins.
  if (available.length === 0) return [];

  const answer = await args.ask(buildModelAuthPrompt(spec.id, available));
  if (answer.cancelled) return [];
  const chosen = parseModelAuthValue(answer.value);
  if (chosen.length === 0) return [];
  // An answer naming a source this host cannot satisfy is a stale answer, not a
  // silent "none" — resolveModelAuthSources throws with the valid values.
  return resolveModelAuthSources(spec, chosen);
}

/** Which declared sources this host can actually satisfy right now. */
export async function listAvailableSources(
  spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>,
  /** Injectable so a test never reads the ambient environment. */
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AvailableSource[]> {
  const { findAgentSpec } = await import('@agentbox/agent-registry');
  const out: AvailableSource[] = [];
  for (const s of spec.modelAuth?.sources ?? []) {
    if (s.kind === 'env') {
      const v = env[s.envKey];
      if (typeof v !== 'string' || v.length === 0) continue;
      out.push({
        id: modelAuthSourceId(s),
        kind: 'env',
        label: s.label,
        ...(s.provider ? { provider: s.provider } : {}),
        ...(s.caveat ? { caveat: s.caveat } : {}),
        envVar: s.envKey,
      });
      continue;
    }
    const hit = await resolveHostCredentialFile(s.agent);
    if (!hit) continue;
    out.push({
      id: modelAuthSourceId(s),
      kind: 'agent',
      label: s.label,
      ...(s.caveat ? { caveat: s.caveat } : {}),
      hostPath: hit.path,
      boxPath: findAgentSpec(s.agent)?.credential?.boxAbsPath ?? '',
      bytes: Buffer.byteLength(hit.text, 'utf8'),
    });
  }
  return out;
}

export type { AgentModelAuthSource };
