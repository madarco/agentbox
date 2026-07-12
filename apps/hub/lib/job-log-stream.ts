// Tail a queue worker's per-job log file (`~/.agentbox/logs/queue-<id>.log`) and
// stream appended lines as SSE `log` events, then a terminal `end` event when the
// job reaches done/failed/cancelled. Shared by /api/jobs/[id]/logs (the create-box
// modal) and /api/v1/jobs/[id]/logs (the public API) so the streaming logic lives
// in one place. Plain fs reads only — never imports the relay/sandbox toolchain;
// the log path + status come from the in-process hub backend.
import { open, stat } from 'node:fs/promises';
import type { HubBackend } from './boxes/backend-types';

const POLL_MS = 500;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
// Emit an SSE comment after this much silence. A create is legitimately quiet for
// minutes at a stretch — the cloud providers log nothing while a VM boots or while
// waiting for SSH — and a silent connection looks dead to a client with a request
// timeout. The tray times out at 120s, reconnects, and the tail replays from offset
// 0, which double-counts every line into its progress bar. Comments are ignored by
// every SSE parser (a line starting with ':'), so this costs nothing but keeps the
// connection provably alive.
const HEARTBEAT_MS = 15_000;

export function streamJobLog(req: Request, id: string, backend: HubBackend, logPath: string): Response {
  const enc = new TextEncoder();
  let offset = 0;
  let residual = '';
  let closed = false;
  let lastEmitAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string): void => {
        try {
          controller.enqueue(enc.encode(chunk));
          lastEmitAt = Date.now();
        } catch {
          /* stream already closed */
        }
      };

      const emit = (event: string, data: unknown): void => {
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Read any bytes appended since the last offset and emit whole lines.
      const drain = async (): Promise<void> => {
        let size: number;
        try {
          size = (await stat(logPath)).size;
        } catch {
          return; // file not created yet (ENOENT) — try again next tick
        }
        if (size <= offset) return;
        const fh = await open(logPath, 'r');
        try {
          const len = size - offset;
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, offset);
          offset = size;
          residual += buf.toString('utf8');
          const lines = residual.split('\n');
          residual = lines.pop() ?? '';
          for (const line of lines) emit('log', line);
        } finally {
          await fh.close();
        }
      };

      const finish = async (status: string): Promise<void> => {
        if (closed) return;
        closed = true;
        await drain().catch(() => {});
        if (residual.length > 0) emit('log', residual);
        emit('end', { status });
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      emit('open', { id });
      let lastLogin = '';
      const timer = setInterval(() => {
        void (async () => {
          await drain().catch(() => {});
          if (!closed && Date.now() - lastEmitAt >= HEARTBEAT_MS) write(':ping\n');
          const cur = await backend.getJob(id).catch(() => null);
          // Surface the Claude re-login sub-state (phase/url/error) on change so the
          // UI can show the login banner + clickable link while the job is running.
          const loginJson = cur?.login ? JSON.stringify(cur.login) : '';
          if (loginJson !== lastLogin) {
            lastLogin = loginJson;
            if (cur?.login) emit('login', cur.login);
          }
          if (!cur || TERMINAL.has(cur.status)) await finish(cur?.status ?? 'gone');
        })();
      }, POLL_MS);

      req.signal.addEventListener('abort', () => {
        clearInterval(timer);
        closed = true;
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
