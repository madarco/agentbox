// Stream a box's SERVICE log (`agentbox-ctl logs <service> --follow`, or the
// ctl-daemon `tail -F`) over SSE. Unlike streamJobLog (which tails a hub-local
// file), the source here is a CHILD PROCESS the hub spawns to reach INTO the box
// — a docker exec, or the provider's SSH/SDK attach argv — so the file-tail core
// doesn't apply. It reuses job-log-stream's SSE framing (event: log / end + the
// `:ping` heartbeat) so both streams stay wire-identical for the CLI client.
import { spawn } from 'node:child_process';
import { HEARTBEAT_MS, SSE_HEADERS, sseFrame } from './job-log-stream';

export interface BoxLogSpawnSpec {
  argv: string[];
  env?: Record<string, string>;
  cleanup?: () => Promise<void>;
}

export function streamBoxLog(req: Request, spec: BoxLogSpawnSpec): Response {
  const enc = new TextEncoder();
  const [cmd, ...args] = spec.argv;
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
      const emit = (event: string, data: unknown): void => write(sseFrame(event, data));

      if (!cmd) {
        emit('end', { status: 'error' });
        controller.close();
        return;
      }

      emit('open', {});
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spec.env ? { ...process.env, ...spec.env } : process.env,
      });

      // Whole-line framing: buffer partial trailing lines across chunks; a follow
      // stream never guarantees chunk-aligned newlines.
      let residual = '';
      const onData = (buf: Buffer): void => {
        residual += buf.toString('utf8');
        const lines = residual.split('\n');
        residual = lines.pop() ?? '';
        for (const line of lines) emit('log', line);
      };
      child.stdout.on('data', onData);
      // The in-box `agentbox-ctl logs` writes its own lines to stdout; surface
      // stderr too (transport errors, "no such service") so they aren't swallowed.
      child.stderr.on('data', onData);

      const finish = (status: string): void => {
        if (closed) return;
        closed = true;
        if (residual.length > 0) emit('log', residual);
        emit('end', { status });
        clearInterval(timer);
        void spec.cleanup?.().catch(() => {});
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const timer = setInterval(() => {
        if (!closed && Date.now() - lastEmitAt >= HEARTBEAT_MS) write(':ping\n');
      }, HEARTBEAT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      child.on('exit', (code) => finish(code === 0 || code === null ? 'done' : 'failed'));
      child.on('error', () => finish('error'));

      // Client hung up (Ctrl-C / closed tab): kill the child so a follow stream
      // doesn't leak a process, then clean up the attach spec.
      req.signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
        finish('aborted');
      });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
