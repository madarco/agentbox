/**
 * Minimal SSE frame reader.
 *
 * Node has no `EventSource`, so a consumer has to buffer to the `\n\n` message
 * boundary and split `event:` / `data:` lines itself. The CLI's prompt stream
 * (`apps/cli/src/wrapped-pty/prompt-client.ts`) already does exactly this — but
 * `@agentbox/relay` cannot import from `apps/cli`, and the relay is a dependency
 * of the CLI rather than the other way round, so the shared copy belongs here.
 * That client can adopt it; until it does, the duplication is deliberate and
 * named rather than silent.
 */

export interface SseFrame {
  /** `event:` name, or 'message' when the frame omits one (the SSE default). */
  event: string;
  /** Concatenated `data:` lines, newline-joined as the spec requires. */
  data: string;
}

/**
 * Feed raw stream chunks in, get whole frames out.
 *
 * Stateful across chunks: a server may split a frame at any byte, and the
 * comment lines servers use as keep-alives (`: connected`) are dropped.
 */
export class SseFrameReader {
  private buffer = '';

  /** Frames completed by this chunk, in order. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const out: SseFrame[] = [];
    let idx = this.buffer.indexOf('\n\n');
    while (idx !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const frame = parseFrame(raw);
      if (frame) out.push(frame);
      idx = this.buffer.indexOf('\n\n');
    }
    return out;
  }

  /** Drop any partial frame — call on reconnect so a torn frame can't merge. */
  reset(): void {
    this.buffer = '';
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    // A line starting with ':' is a comment: keep-alives and the connect
    // preamble arrive that way and carry no event.
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}
