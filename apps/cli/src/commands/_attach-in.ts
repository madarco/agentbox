import type { AttachOpenIn } from '@agentbox/config';

const VALUES: readonly AttachOpenIn[] = ['split', 'window', 'tab', 'same'] as const;

export const ATTACH_IN_HELP =
  'where to open the attached session: split | window | tab | same (default from attach.openIn, built-in: split). Only effective when running inside tmux or iTerm2; falls back to inline attach otherwise.';

export const INLINE_HELP =
  'attach inline in the current terminal (shortcut for --attach-in same; useful when attach.openIn defaults to split/window/tab). The short `-i` form was reassigned to `--initial-prompt` on the create-style commands (claude/codex/opencode).';

export const NO_ATTACH_HELP =
  'create the box and start the agent session, but do not attach (background mode); prints the box ref and exits 0. Re-attach later with `agentbox <agent> attach <box>`.';

/**
 * Validate a `--attach-in` value as it comes off commander. Returns
 * `undefined` when the flag was absent (so it doesn't clobber the config-layer
 * value); throws a clear error on a typo.
 */
export function parseAttachInOption(raw: string | undefined): AttachOpenIn | undefined {
  if (raw === undefined) return undefined;
  if (!(VALUES as readonly string[]).includes(raw)) {
    throw new Error(
      `--attach-in: expected one of ${VALUES.join(', ')}, got "${raw}"`,
    );
  }
  return raw as AttachOpenIn;
}

/**
 * Resolve `--attach-in <mode>` + `--inline`/`-i` into a single `AttachOpenIn`.
 * `--attach-in` wins when both are given (more specific overrides the
 * shortcut); `--inline` alone maps to `'same'`; absent flags resolve to
 * `undefined` so the config-layer value still applies.
 */
export function resolveAttachInOption(opts: {
  attachIn?: string;
  inline?: boolean;
}): AttachOpenIn | undefined {
  if (opts.attachIn !== undefined) return parseAttachInOption(opts.attachIn);
  if (opts.inline === true) return 'same';
  return undefined;
}
