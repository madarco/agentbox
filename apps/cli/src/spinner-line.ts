/**
 * Clamp a spinner message to fit on a single terminal row.
 *
 * @clack/prompts' spinner redraws in place by emitting cursor-up + clear-line
 * sequences sized to the lines it last drew. When a message is longer than the
 * terminal is wide, the terminal wraps it onto extra visual rows the spinner
 * doesn't know about — the next frame's clear hits only the last visual row
 * and the rest pile up in scrollback. Docker's build output during the apt-get
 * phase (Get:19 http://ports.ubuntu.com/... long URLs) routinely blows past
 * 100 columns, which is what triggers the symptom in `agentbox create` /
 * `agentbox claude` on the first run when the image is being built.
 *
 * Falls back to the raw line on non-TTY stdout (no spinner is drawn, so
 * wrapping is harmless).
 */
const SPINNER_CHROME = 6;

export function clampSpinnerLine(line: string): string {
  const cols = process.stdout.columns;
  if (!process.stdout.isTTY || !cols) return line;
  const trimmed = line.replace(/\s+$/, '');
  const max = cols - SPINNER_CHROME;
  if (max <= 1 || trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
