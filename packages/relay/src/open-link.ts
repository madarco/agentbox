/**
 * "Open this link where the human actually is."
 *
 * A box that opens a URL (`agentbox-ctl open`, or anything through the box's
 * `$BROWSER`/`xdg-open` shim — an OAuth flow, `gh`, a dev-server preview) asks
 * the relay to mirror it on the host. Executing that in the relay process is
 * only right when the relay IS the human's machine: on a control box it opens a
 * browser on the VPS and the human sees nothing.
 *
 * So the relay decides *whether* the link may open (safe subset +
 * {@link browserOpenBudget}, server-side so every surface shares one policy) and
 * then hands it to whichever surface is attached, as an `open-link` prompt. The
 * claim is `PendingPrompts.resolve` — first caller wins, losers get 404 — which
 * is why every client claims BEFORE it opens. `openedByClient` on the answer is
 * how the winner tells the relay not to open it a second time.
 *
 * Shared by the docker (`server.ts`) and cloud (`host-actions.ts`) mirror paths
 * for the same reason `safe-transfer.ts` is: the policy must not drift between
 * the two transports.
 */

import { randomUUID } from 'node:crypto';
import { openOnHost } from '@agentbox/sandbox-core';
import { browserOpenBudget, type BrowserOpenBudget } from './browser-open-budget.js';
import type { PendingPrompts, PromptSubscribers } from './prompts.js';
import type { PromptAskEvent } from './types.js';

/** How long an unclaimed open-link offer stays in the mailbox. */
export const OPEN_LINK_TTL_MS = 90_000;

export interface OpenLinkDeps {
  prompts: PendingPrompts;
  subscribers: PromptSubscribers;
  boxId: string;
  /** Box name for the card text; falls back to the id. */
  boxName?: string;
  /** `box.autoApproveSafeHostActions !== false` — the safe-subset gate. */
  autoApproveSafe: boolean;
  /**
   * True when this relay is a control box: it is not the human's machine, so it
   * must never open a link itself, however the offer ends.
   */
  controlPlane?: boolean;
  ttlMs?: number;
  /** Test seam; defaults to the process-wide budget both transports share. */
  budget?: BrowserOpenBudget;
  /** Test seam; defaults to a detached spawn of the host's URL handler. */
  openHost?: (url: string) => void;
  log?: (msg: string) => void;
}

/** What {@link offerBrowserOpen} did, for logs and tests. */
export type OpenLinkOutcome =
  /** Duplicate link inside the dedupe window — nothing happened. */
  | 'dropped'
  /** No surface attached and this relay is the human's machine: opened here. */
  | 'opened-locally'
  /** A client claimed it and opened it on its own machine. */
  | 'opened-by-client'
  /** Claimed with a plain `y` (a client that can't open) — opened here. */
  | 'opened-after-answer'
  /** Denied, dismissed, or expired unclaimed. */
  | 'unclaimed';

/**
 * Offer `url` to the box's attached surfaces, and open it here when this relay
 * is the right machine and nobody else will. Resolves once the offer is settled;
 * the docker path fires it without awaiting (the box already got its 200).
 */
export async function offerBrowserOpen(deps: OpenLinkDeps, url: string): Promise<OpenLinkOutcome> {
  const budget = deps.budget ?? browserOpenBudget;
  const open = deps.openHost ?? openOnHost;
  const decision = budget.decide(deps.boxId, url, deps.autoApproveSafe);
  if (decision.action === 'drop') return 'dropped';
  // Charge an approved link against the budget HERE, not when it finally
  // opens. The box's `/rpc` is answered before the offer is even made, so a
  // looping agent fires the next `browser.open` while this one is still parked
  // — waiting for the claim to record would let every link in the loop see an
  // empty window, clear the burst limit, and be claimed together. That is the
  // tab-spray the budget exists to stop.
  if (decision.action === 'open') budget.record(deps.boxId, url);

  const promptEvent: Omit<PromptAskEvent, 'id'> = {
    kind: 'open-link',
    message: `Open link from box ${deps.boxName ?? deps.boxId}?`,
    detail: url,
    defaultAnswer: 'n',
    url,
    ...(decision.action === 'open' ? { autoOpen: true } : {}),
    context: { command: 'browser.open', argv: [url] },
  };

  // Approved, nobody streaming, and this relay is the human's own machine:
  // open it here and now. Skipping the offer keeps the laptop path instant and
  // is exactly what the relay did before surfaces could claim.
  //
  // A link that still needs a human is parked even with no stream attached —
  // the tray and the hub web UI read the approvals mailbox over REST, and
  // neither counts as a subscriber, so dropping it would hide the link from the
  // two surfaces most likely to be there when no terminal is.
  if (
    decision.action === 'open' &&
    !deps.controlPlane &&
    deps.subscribers.count(deps.boxId) === 0
  ) {
    deps.prompts.noteAutoApprove(deps.boxId, promptEvent, decision.reason);
    open(url);
    return 'opened-locally';
  }

  // `box.autoApproveHostActions` — the blanket opt-in — used to resolve this
  // confirm through `askPrompt`. Honour it here too (it audits itself), or an
  // unattended box that opted into everything would park an over-budget link
  // and drop it at the TTL instead of opening it.
  if (decision.action !== 'open' && deps.prompts.consumeAutoApprove(deps.boxId, promptEvent)) {
    budget.record(deps.boxId, url);
    if (deps.controlPlane) {
      deps.log?.(`browser.open: auto-approved but nothing here can open it (control box): ${url}`);
      return 'unclaimed';
    }
    open(url);
    return 'opened-locally';
  }

  const ev: PromptAskEvent = { id: randomUUID(), ...promptEvent };
  const settled = deps.prompts.add(deps.boxId, ev);
  const timer = setTimeout(() => {
    if (deps.prompts.resolve(ev.id, 'n', true)) {
      deps.subscribers.broadcast(deps.boxId, 'prompt-resolved', { id: ev.id });
    }
  }, deps.ttlMs ?? OPEN_LINK_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  deps.subscribers.broadcast(deps.boxId, 'prompt-ask', ev);

  const verdict = await settled;
  clearTimeout(timer);
  if (verdict.answer !== 'y' || verdict.cancelled) return 'unclaimed';
  if (decision.action === 'open') {
    deps.prompts.noteAutoApprove(deps.boxId, promptEvent, decision.reason);
  } else {
    // Only the over-budget path is uncharged at this point: an approved link
    // was recorded before it was offered.
    budget.record(deps.boxId, url);
  }
  if (verdict.openedByClient) return 'opened-by-client';
  // A plain `y`: the answering surface either can't open URLs or predates
  // `open-link` and rendered a confirm. Open it here — unless "here" is a
  // control box, where that would just pop a tab nobody can see.
  if (deps.controlPlane) {
    deps.log?.(`browser.open: approved but no client opened it (control box): ${url}`);
    return 'unclaimed';
  }
  open(url);
  return 'opened-after-answer';
}
