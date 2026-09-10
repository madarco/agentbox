/**
 * Run every create-time host-boundary gate for a hub create, once, with a
 * caller-supplied asker.
 *
 * Both the preflight (`collectAsker` — what would you ask?) and the create
 * itself (`answerMapAsker` — here are the answers) call THIS function, so the
 * questions a client is shown are by construction the questions the create
 * asks. Adding a gate here reaches all four front-ends at once.
 */

import {
  agentSettings,
  loadEffectiveConfig,
  readCarryGrant,
  type ConfigSource,
} from '@agentbox/config';
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
   * The carry decision, already made without asking — the API equivalent of the
   * CLI's `--carry-yes`. Used by `clone`, which has no human to ask and inherits
   * the grant the source box already holds for this project (the same rule
   * `resyncCarryFiles` applies when it re-copies within an existing grant).
   */
  carryYes?: boolean;
  /**
   * Model-auth chosen up front, the API equivalent of `--model-auth`. Takes
   * precedence over asking, exactly as the flag does; an empty array means an
   * explicit "none", which is why it is threaded here rather than merged with
   * the gate's answer afterwards.
   */
  borrowCredentials?: string[];
  /**
   * Dry run: ask every gate its question and DECIDE nothing.
   *
   * Load-bearing for the preflight. A collecting asker answers each prompt with
   * its own fallback, and carry's fallback is `cancel` — so without this the
   * carry gate would abort the run and every later gate's question would be
   * missing from the list the client is shown.
   */
  collecting?: boolean;
  /**
   * Re-open a carry approval this project already gave — the API equivalent of
   * `--carry ask`. Without it a granted list is unreachable from the web UI and
   * the tray: they would never see the table again, and so could never withdraw
   * an approval to copy host secrets.
   */
  carryAsk?: boolean;
  onLog?: (line: string) => void;
}

export interface CreateGateResult {
  /** Approved `carry:` entries — empty when skipped or when there are none. */
  carry: ResolvedCarryEntry[];
  /**
   * Identity of the carry list that was approved, for the caller to store as a
   * standing grant. Absent when there was nothing to carry, or when the carry
   * decision was not an approval.
   */
  carryGrantId?: string;
  /**
   * The approval came from the project's existing grant, not from a human just
   * now — so there is nothing new to record.
   */
  carryFromGrant?: boolean;
  /**
   * A human was shown the table and declined while the project HELD a grant:
   * the caller should withdraw it.
   */
  carryDeclined?: boolean;
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

  // The project's standing approval of this exact list, if it has one. Read on
  // BOTH paths: the preflight consults it too, which is what stops the web
  // modal and the tray card asking again for a list already approved.
  const granted = await readCarryGrant(input.workspace);

  const gate = await runCarryGate({
    projectRoot: input.workspace,
    items,
    replacements,
    maxBytes: cfg.effective.box.cpMaxBytes,
    ask: input.ask,
    ...(input.carryYes ? { carryYes: true } : {}),
    ...(granted ? { approvedGrantId: granted.approvedId } : {}),
    ...(input.carryAsk ? { carryAsk: true } : {}),
    onLog: emit,
  });
  if (gate.decision === 'cancel' && !input.collecting) {
    return { carry: [], borrowCredentials: [], cancelled: true, unavailable };
  }
  const carry = gate.decision === 'approve' ? gate.entries : [];
  // Handed back rather than written here: only the real create means a box is
  // being made (a preflight must never grant), and writing from this function
  // would put ~/.agentbox writes inside a test that has no HOME isolation.
  const carryGrant =
    gate.decision === 'approve' && gate.grantId
      ? { carryGrantId: gate.grantId, ...(gate.fromGrant ? { carryFromGrant: true } : {}) }
      : // Declined after being shown the table: the caller withdraws the standing
        // approval, so the next create asks rather than silently copying what was
        // just refused.
        gate.asked && granted
        ? { carryDeclined: true }
        : {};

  const spec = input.agent === 'none' ? undefined : findAgentSpec(input.agent);
  let borrowCredentials: string[] = [];
  if (input.borrowCredentials !== undefined) {
    // Chosen up front — don't ask, and don't let an empty array (an explicit
    // "none") fall through to anything else.
    borrowCredentials = input.borrowCredentials;
  } else if (spec?.modelAuth) {
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

  return { carry, ...carryGrant, borrowCredentials, cancelled: false, unavailable };
}
