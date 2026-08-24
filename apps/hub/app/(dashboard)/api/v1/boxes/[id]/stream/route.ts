// GET /api/v1/boxes/:id/stream — the payload-carrying per-box SSE channel for
// the attach footer. Unlike /api/events (refetch signals only, `data: {}`), this
// pushes the full `prompt-ask` / `prompt-resolved` / `notice-set` /
// `notice-clear` / `box-status` payloads the footer renders. Per-box: `:id` is
// the box id the footer attached to (prompts are keyed by exact box id, so no
// resolution here).
//
// `box-status` is why the footer needs no status polling. It matters most for a
// box this hub owns but the user's laptop does not: the durable
// `~/.agentbox/boxes/<id>/status.json` is written by whichever relay the box
// reports to, so a laptop attached to a control-box-created box has no such
// file and this stream is its only source.
//
// Gated by proxy.ts exactly like the rest of /api/v1 (Bearer API key / hub token),
// which is the point of this route: it retires the footer's last admin-token wire.
// Reaches the relay's in-process prompt fan-out via the __AGENTBOX_HUB_PROMPTS
// seam (set by server.ts). Absent on the Postgres/plane topology (no in-process
// relay) — there it degrades to open + heartbeat, same as /api/events.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 15_000;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const prompts = globalThis.__AGENTBOX_HUB_PROMPTS;
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown): void => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* stream closed between abort and a queued write */
        }
      };
      send('open', {});
      // Subscribe BEFORE flushing the backlog (matching the relay's own
      // /admin/prompts/stream): a prompt arriving in the gap between a backlog
      // snapshot and registration would otherwise be lost. The reverse order can
      // only duplicate a `prompt-ask` (in the backlog AND freshly broadcast),
      // which the footer dedupes by id — a missed prompt it cannot recover.
      let unsub = (): void => {};
      if (prompts) {
        unsub = prompts.subscribe(id, (event, data) => send(event, data));
        // Then flush any already-parked prompt (+ in-progress notice) so a
        // wrapper attaching to a blocked box sees it immediately. Prompts outrank
        // notices, matching the admin stream.
        const backlog = prompts.backlog(id);
        for (const ev of backlog.prompts) send('prompt-ask', ev);
        for (const ev of backlog.notices) send('notice-set', ev);
        // Last, so an attach that lands mid-approval paints the prompt first.
        if (backlog.status !== undefined) send('box-status', backlog.status);
      }
      const ping = setInterval(() => send('ping', { ts: new Date().toISOString() }), HEARTBEAT_MS);
      req.signal.addEventListener('abort', () => {
        clearInterval(ping);
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
