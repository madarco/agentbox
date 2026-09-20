/**
 * The one key sequence an attach client interprets instead of forwarding.
 *
 * Owning the pty means there is no tmux prefix and no status bar telling you
 * how to leave, so `agentbox manager attach` from a plain shell needs a way
 * out. Everything else is forwarded byte for byte — that is the whole point of
 * the carrier — so the chord is deliberately one obscure key: `Ctrl-]`, the
 * classic telnet escape, which no agent TUI binds and no keyboard produces by
 * accident. `none` turns it off for a client (the tray) whose window already is
 * the detach affordance.
 */

export const DEFAULT_DETACH_KEY = 'C-]';

/**
 * Control byte for a `C-<char>` spec, `null` for an explicit `none`, and
 * `undefined` for a spec that cannot be parsed.
 *
 * The three are deliberately distinct: silently treating a typo as `none` would
 * leave the user attached with no way out but killing the terminal, and no hint
 * that the key they configured was never understood.
 */
export function parseDetachKey(spec: string | undefined): number | null | undefined {
  const value = (spec ?? DEFAULT_DETACH_KEY).trim();
  if (value === '' || value.toLowerCase() === 'none') return null;
  const match = /^(?:C|c|Ctrl|ctrl)-(.)$/u.exec(value);
  if (!match) return undefined;
  const ch = (match[1] as string).toUpperCase();
  const code = ch.charCodeAt(0);
  // @ A-Z [ \ ] ^ _ map to 0x00-0x1f, which is what Ctrl does to them.
  if (code < 0x40 || code > 0x5f) return undefined;
  return code - 0x40;
}

export interface ChordStep {
  /** Bytes to forward to the session. */
  forward: Uint8Array;
  /** The user asked to leave. */
  detach: boolean;
}

/**
 * Leader then `d` detaches; leader twice sends one literal leader; leader then
 * anything else forwards both, so a mistyped chord types the key rather than
 * swallowing it. No timeout — a chord that expires is a chord you cannot trust.
 */
export class DetachChord {
  private armed = false;

  constructor(private readonly leader: number | null) {}

  feed(chunk: Uint8Array): ChordStep {
    if (this.leader === null) return { forward: chunk, detach: false };
    const out: number[] = [];
    for (const byte of chunk) {
      if (this.armed) {
        this.armed = false;
        if (byte === 0x64 || byte === 0x04) return { forward: new Uint8Array(out), detach: true };
        if (byte === this.leader) {
          out.push(this.leader);
          continue;
        }
        out.push(this.leader, byte);
        continue;
      }
      if (byte === this.leader) {
        this.armed = true;
        continue;
      }
      out.push(byte);
    }
    return { forward: new Uint8Array(out), detach: false };
  }
}

/** How the chord reads in a one-line hint. */
export function describeDetachKey(leader: number | null, spec: string | undefined): string {
  if (leader === null) return '';
  return `${(spec ?? DEFAULT_DETACH_KEY).replace(/^ctrl-/iu, 'C-')} d`;
}
