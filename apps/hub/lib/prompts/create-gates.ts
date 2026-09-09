/**
 * Run every create-time host-boundary gate for a hub create, once, with a
 * caller-supplied asker.
 *
 * Both the preflight (`collectAsker` — what would you ask?) and the create
 * itself (`answerMapAsker` — here are the answers) call THIS function, so the
 * questions a client is shown are by construction the questions the create
 * asks. Adding a gate here reaches all four front-ends at once.
 */

import { agentSettings, loadEffectiveConfig, type ConfigSource } from '@agentbox/config';
import type { PromptAsker, ResolvedCarryEntry } from '@agentbox/core';
import { loadCarrySpec } from '@agentbox/ctl';
import {
  findAgentSpec,
  MODEL_AUTH_SETTING,
  resolveModelAuth,
  runCarryGate,
} from '@agentbox/sandbox-core';

/** A gate that could not run here, and why — reported rather than skipped. */
export interface UnavailableGate {
  topic: string;
  reason: string;
}

export interface CreateGateInput {
  /** Absolute project root on THIS machine. */
  workspace: string;
  /** The agent the box is being created for; `none` for an agentless box. */
  agent: string;
  ask: PromptAsker;
  /**
   * Dry run: ask every gate its question and DECIDE nothing.
   *
   * Load-bearing for the preflight. A collecting asker answers each prompt with
   * its own fallback, and carry's fallback is `cancel` — so without this the
   * carry gate would abort the run and every later gate's question would be
   * missing from the list the client is shown.
   */
  collecting?: boolean;
  onLog?: (line: string) => void;
}

export interface CreateGateResult {
  /** Approved `carry:` entries — empty when skipped or when there are none. */
  carry: ResolvedCarryEntry[];
  /** Agents whose host login the box should be seeded with. */
  borrowCredentials: string[];
  /** True when the user asked to abandon the create. */
  cancelled: boolean;
  unavailable: UnavailableGate[];
}

export async function runCreateGates(input: CreateGateInput): Promise<CreateGateResult> {
  const emit = input.onLog ?? (() => {});
  const unavailable: UnavailableGate[] = [];

  const { items, replacements } = await loadCarrySpec(input.workspace);
  const cfg = await loadEffectiveConfig(input.workspace);

  const gate = await runCarryGate({
    projectRoot: input.workspace,
    items,
    replacements,
    maxBytes: cfg.effective.box.cpMaxBytes,
    ask: input.ask,
    onLog: emit,
  });
  if (gate.decision === 'cancel' && !input.collecting) {
    return { carry: [], borrowCredentials: [], cancelled: true, unavailable };
  }
  const carry = gate.decision === 'approve' ? gate.entries : [];

  const spec = input.agent === 'none' ? undefined : findAgentSpec(input.agent);
  let borrowCredentials: string[] = [];
  if (spec?.modelAuth) {
    // `sources` says whether the user set `<agent>.modelAuth` themselves; a hub
    // create reads the hub's own effective config, the same way a bake does.
    const sources = cfg.sources as Record<string, ConfigSource>;
    borrowCredentials = await resolveModelAuth({
      spec,
      settings: agentSettings(cfg.effective, spec.id),
      configuredExplicitly:
        (sources[`${spec.id}.${MODEL_AUTH_SETTING}`] ?? 'default') !== 'default',
      ask: input.ask,
    });
    for (const a of borrowCredentials) emit(`model auth: borrowing the ${a} login`);
  }

  return { carry, borrowCredentials, cancelled: false, unavailable };
}
