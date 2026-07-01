import { supportsHyperlink } from 'supports-hyperlinks';

const ESC = '\x1b';
const ST = `${ESC}\\`;

/**
 * Wrap `label` in an OSC-8 hyperlink pointing at `url`, when the target stream
 * is a TTY whose terminal program is known to support OSC-8 (iTerm2, WezTerm,
 * Ghostty, recent VS Code, etc. — `supports-hyperlinks` does the detection).
 * Falls back to the plain label otherwise so piped output stays clean.
 *
 * `force` skips the detection — use it when the consumer is known to support
 * OSC-8 regardless of what `supports-hyperlinks` infers (e.g. output rendered in
 * a Herdr pane, where the link is what drives Ctrl+click routing).
 */
export function hyperlink(
  label: string,
  url: string,
  stream?: NodeJS.WriteStream,
  force = false,
): string {
  const out = stream ?? process.stdout;
  if (!force && !supportsHyperlink(out)) return label;
  return `${ESC}]8;;${url}${ST}${label}${ESC}]8;;${ST}`;
}
