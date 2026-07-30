// GET /api/v1/boxes/:id/prompts/stream — the payload-carrying prompt SSE channel
// for the attach footer. Unlike /api/events (refetch signals only, `data: {}`),
// this pushes the full `prompt-ask` / `prompt-resolved` / `notice-set` /
// `notice-clear` payloads the footer renders. Per-box: `:id` is the box id the
// footer attached to (prompts are keyed by exact box id, so no resolution here).
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
      // Flush the backlog first — a wrapper attaching to a box that already has a
      // parked prompt (or an in-progress notice) must see it immediately. Prompts
      // outrank notices, matching the relay's own /admin/prompts/stream flush.
      let unsub = (): void => {};
      if (prompts) {
        const backlog = prompts.backlog(id);
        for (const ev of backlog.prompts) send('prompt-ask', ev);
        for (const ev of backlog.notices) send('notice-set', ev);
        unsub = prompts.subscribe(id, (event, data) => send(event, data));
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
