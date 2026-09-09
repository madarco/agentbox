/**
 * The terminal asker: renders a {@link PromptRequest} with clack and returns the
 * user's answer. One of three implementations of the same seam (the hub has a
 * collecting asker for its preflight and a map-backed asker that replays what a
 * client posted), so a gate's logic is written once and asked three ways.
 *
 * Non-TTY is where the two halves of the schema earn their keep: a `required`
 * prompt has no safe silent answer, so it throws with the gate's own
 * `nonInteractiveHint`; anything else takes `fallback` and says so. This is what
 * preserves the rule that `-y` must never auto-approve a `carry:` block.
 */

import { confirm, isCancel, log, select, text } from '@agentbox/cli-kit';
import type { PromptAnswer, PromptAsker, PromptRequest } from '@agentbox/core';

export interface ClackAskerOptions {
  /** Caller-controlled TTY check; defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
  onLog?: (line: string) => void;
}

/** Build a clack-backed {@link PromptAsker}. */
export function clackAsker(opts: ClackAskerOptions = {}): PromptAsker {
  return async (req: PromptRequest): Promise<PromptAnswer> => {
    const tty = opts.isTTY ?? process.stdin.isTTY;
    if (!tty) return nonInteractive(req, opts.onLog);

    printDetail(req);

    if (req.kind === 'text') {
      const answer = await text({
        message: req.title,
        ...(req.defaultValue !== undefined ? { initialValue: req.defaultValue } : {}),
      });
      return isCancel(answer)
        ? { id: req.id, value: req.fallback.value, cancelled: true }
        : { id: req.id, value: String(answer) };
    }

    if (req.kind === 'confirm') {
      const answer = await confirm({
        message: req.title,
        initialValue: req.defaultValue !== 'n',
      });
      return isCancel(answer)
        ? { id: req.id, value: req.fallback.value, cancelled: true }
        : { id: req.id, value: answer ? 'y' : 'n' };
    }

    const choices = req.choices ?? [];
    const answer = await select<string>({
      message: req.title,
      options: choices.map((c) => ({
        value: c.value,
        label: c.label,
        ...(c.hint ? { hint: c.hint } : {}),
      })),
      ...(req.defaultValue !== undefined ? { initialValue: req.defaultValue } : {}),
    });
    return isCancel(answer)
      ? { id: req.id, value: req.fallback.value, cancelled: true }
      : { id: req.id, value: answer };
  };
}

/**
 * No TTY: refuse a `required` prompt, else take the fallback out loud.
 *
 * The refusal message is the gate's own `nonInteractiveHint`, so the escape
 * hatch a user is told about is always the one that actually exists.
 */
function nonInteractive(req: PromptRequest, onLog?: (line: string) => void): PromptAnswer {
  if (req.required) {
    const hint = req.nonInteractiveHint ? ` ${req.nonInteractiveHint}` : '';
    throw new Error(`${req.title} — requires approval but stdin is not a TTY.${hint}`);
  }
  onLog?.(`${req.topic}: ${req.fallback.reason}`);
  return { id: req.id, value: req.fallback.value };
}

/** Render the typed detail, richest form first, falling back to `summary`. */
function printDetail(req: PromptRequest): void {
  if (req.body) log.message(req.body);
  const d = req.detail;
  if (!d) return;
  switch (d.type) {
    case 'file-table':
      log.message(indent(d.summary));
      break;
    case 'credential':
      log.message(indent(`${d.label}\n${d.hostPath}  ->  ${d.boxPath}`));
      if (d.caveat) log.warn(d.caveat);
      break;
    default:
      // An unknown variant still has a summary — that is the contract.
      log.message(indent(d.summary));
  }
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}
