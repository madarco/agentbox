// Live-updates SSE stream. The browser subscribes with EventSource; the custom
// server's HubNotifier (globalThis.__AGENTBOX_HUB_NOTIFIER) fires a `change`
// whenever the pending-approval set mutates, and a `ping` heartbeat every 15s
// doubles as a catch-all refresh for box changes made outside the hub.
//
// This is a same-origin Next route gated by proxy.ts (the matcher excludes only
// `api/auth`, not `api/events`), which auths it exactly like /api/v1: the browser
// token/session cookie rides along, and a headless client (the tray against a
// remote control box) subscribes with an Authorization: Bearer key. It is NOT a
// relay route (the relay owns `/events` POST, not `/api/events`), so it falls
// through to Next on the embedded server. On vercel there is no notifier — the
// stream degrades to heartbeats only.
import { closeOnDeviceRevoke } from '@/lib/request-actor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 15_000;

export function GET(req: Request): Response {
  const notifier = globalThis.__AGENTBOX_HUB_NOTIFIER;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string): void => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: {}\n\n`));
        } catch {
          /* stream closed between abort and interval tick */
        }
      };
      send('open');
      const unsub = notifier?.subscribe(() => send('change')) ?? (() => {});
      const ping = setInterval(() => send('ping'), HEARTBEAT_MS);
      let unwatchRevoke = (): void => {};
      const end = (): void => {
        clearInterval(ping);
        unsub();
        unwatchRevoke();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      // A revoked device's stream ends now, not at its next reconnect.
      unwatchRevoke = closeOnDeviceRevoke(req, end);
      req.signal.addEventListener('abort', end);
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
