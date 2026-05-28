const ESC = '\x1b';
const BEL = '\x07';

/** Replace control chars that would otherwise break the OSC string (the BEL
 *  terminator, or any C0 byte) and trim — a stray newline in the agent's
 *  session title must not corrupt the host terminal. */
function sanitize(title: string): string {
  return title.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

/**
 * Set the host terminal's title via OSC 0 (`ESC ] 0 ; <title> BEL`), which sets
 * both the window and icon title — the same sequence Claude Code emits. Guarded
 * by `isTTY` so piped / redirected output stays clean.
 */
export function setTerminalTitle(
  title: string,
  stream: NodeJS.WriteStream = process.stdout,
): void {
  if (!stream.isTTY) return;
  stream.write(`${ESC}]0;${sanitize(title)}${BEL}`);
}

/**
 * Push the terminal's current title onto its title stack (XTPUSHTITLE,
 * `CSI 22 ; 2 t`). Pair with {@link popTerminalTitle} on exit so the user's
 * original tab title is restored. Terminals without title-stack support ignore
 * the unknown CSI.
 */
export function pushTerminalTitle(stream: NodeJS.WriteStream = process.stdout): void {
  if (!stream.isTTY) return;
  stream.write(`${ESC}[22;2t`);
}

/** Pop the title saved by {@link pushTerminalTitle} (XTPOPTITLE, `CSI 23 ; 2 t`). */
export function popTerminalTitle(stream: NodeJS.WriteStream = process.stdout): void {
  if (!stream.isTTY) return;
  stream.write(`${ESC}[23;2t`);
}
