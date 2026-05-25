import type { AttachOpenIn } from '@agentbox/config';

const VALUES: readonly AttachOpenIn[] = ['split', 'window', 'tab', 'same'] as const;

export const ATTACH_IN_HELP =
  'where to open the attached session: split | window | tab | same (default from attach.openIn, built-in: split). Only effective when running inside tmux or iTerm2; falls back to inline attach otherwise.';

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
