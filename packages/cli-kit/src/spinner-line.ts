/**
 * Clamp a spinner message to fit on a single terminal row.
 *
 * @clack/prompts' spinner redraws in place by emitting cursor-up + clear-line
 * sequences sized to the lines it last drew. Two ways the redraw gets out of
 * sync with the actual rendered output:
 *
 * 1. When a single-line message is longer than the terminal is wide, the
 *    terminal wraps it onto extra visual rows the spinner doesn't know
 *    about — the next frame's clear hits only the last visual row and the
 *    rest pile up in scrollback. Docker's build output during the apt-get
 *    phase (Get:19 http://ports.ubuntu.com/... long URLs) routinely blows
 *    past 100 columns.
 *
 * 2. When the message itself contains embedded newlines (multi-line),
 *    clack only redraws the *first* line; subsequent lines from the
 *    previous frame stay on the terminal, producing the "stair-stepped"
 *    pile-up seen during `agentbox create --provider daytona` where
 *    Daytona's `Image.fromDockerfile` callback hands us whole multi-line
 *    chunks.
 *
 * The fix is to collapse multi-line input to its last non-empty line (the
 * most recent progress signal) and then clamp width.
 *
 * Falls back to the raw single-line input on non-TTY stdout (no spinner is
 * drawn, so wrapping is harmless).
 */
const SPINNER_CHROME = 6;

export function clampSpinnerLine(line: string): string {
  // Collapse to a single line first — the last non-empty line is almost
  // always the freshest progress signal (e.g. "Get:21 http://... [49 kB]").
  const collapsed = collapseToLastLine(line);
  const cols = process.stdout.columns;
  if (!process.stdout.isTTY || !cols) return collapsed;
  const trimmed = collapsed.replace(/\s+$/, '');
  const max = cols - SPINNER_CHROME;
  if (max <= 1 || trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function collapseToLastLine(s: string): string {
  // Strip CR (so CRLF and bare \r progress bars both fold) and split on \n.
  const lines = s.replace(/\r/g, '\n').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && line.trim().length > 0) return line;
  }
  return '';
}
