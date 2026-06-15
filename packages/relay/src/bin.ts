import { Command } from 'commander';
import { request as httpRequest } from 'node:http';
import { DEFAULT_RELAY_PORT } from './types.js';
import { startRelayServer } from './server.js';
import { startAutopauseLoop } from './autopause.js';
import { startQueueLoop } from './queue.js';

const program = new Command();

program
  .name('agentbox-relay')
  .description('Host-side HTTP relay for box→host events and RPCs')
  .version('0.0.0');

program
  .command('serve')
  .description('Run the HTTP relay in the foreground')
  .option('--port <number>', 'port to listen on', String(DEFAULT_RELAY_PORT))
  .option('--host <addr>', 'bind address', '0.0.0.0')
  .option(
    '--control-box',
    'run as an always-on control box: gate /admin and /remote on AGENTBOX_RELAY_ADMIN_TOKEN instead of loopback',
  )
  .action(async (opts: { port: string; host: string; controlBox?: boolean }) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      process.stderr.write(`agentbox-relay: invalid port "${opts.port}"\n`);
      process.exit(2);
    }
    // In control-box mode the admin token comes from the box's root-only env
    // file (sourced into this process); fail fast with a clear message rather
    // than letting createRelayServer throw a generic error.
    const adminToken = process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '';
    if (opts.controlBox && adminToken.length === 0) {
      process.stderr.write(
        'agentbox-relay: --control-box requires AGENTBOX_RELAY_ADMIN_TOKEN to be set\n',
      );
      process.exit(2);
    }
    const handle = await startRelayServer({
      port,
      host: opts.host,
      controlBox: opts.controlBox === true,
      adminToken,
      logger: (line) => process.stdout.write(`agentbox-relay: ${line}\n`),
    });
    process.stdout.write(
      `agentbox-relay: listening on ${opts.host}:${String(port)}${opts.controlBox ? ' (control-box mode)' : ''}\n`,
    );

    const autopause = startAutopauseLoop({
      registry: handle.registry,
      statusStore: handle.statusStore,
      events: handle.events,
      log: (line) => process.stdout.write(`agentbox-relay: ${line}\n`),
    });
    const queue = startQueueLoop({
      log: (line) => process.stdout.write(`agentbox-relay: ${line}\n`),
      registry: handle.registry,
      statusStore: handle.statusStore,
    });
    handle.setQueuePoke(() => {
      (queue as { poke?: () => void }).poke?.();
    });

    const shutdown = (signal: string): void => {
      process.stdout.write(`agentbox-relay: ${signal} — shutting down\n`);
      Promise.allSettled([autopause.stop(), queue.stop()])
        .finally(() => handle.close())
        .finally(() => process.exit(0));
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });

program
  .command('register')
  .description('Register a box token (in-container shim; POSTs to local relay)')
  .requiredOption('--id <boxId>', 'box id')
  .requiredOption('--token <token>', 'box auth token')
  .requiredOption('--name <name>', 'human-readable box name')
  .option('--port <number>', 'relay port', String(DEFAULT_RELAY_PORT))
  .action(async (opts: { id: string; token: string; name: string; port: string }) => {
    await adminPost('/admin/register-box', { boxId: opts.id, token: opts.token, name: opts.name }, opts.port);
  });

program
  .command('forget')
  .description('Forget a box (in-container shim; POSTs to local relay)')
  .requiredOption('--id <boxId>', 'box id')
  .option('--port <number>', 'relay port', String(DEFAULT_RELAY_PORT))
  .action(async (opts: { id: string; port: string }) => {
    await adminPost('/admin/forget-box', { boxId: opts.id }, opts.port);
  });

program
  .command('tail')
  .description('Print recent events (in-container shim; GETs from local relay)')
  .option('--box <id>', 'filter by box id')
  .option('--since <id>', 'return events with id > since', '0')
  .option('--port <number>', 'relay port', String(DEFAULT_RELAY_PORT))
  .action(async (opts: { box?: string; since: string; port: string }) => {
    const params = new URLSearchParams();
    if (opts.box) params.set('box', opts.box);
    params.set('since', opts.since);
    const reply = await adminGet(`/admin/events?${params.toString()}`, opts.port);
    process.stdout.write(reply + '\n');
  });

async function adminPost(path: string, body: unknown, portStr: string): Promise<void> {
  const port = Number.parseInt(portStr, 10);
  const json = JSON.stringify(body);
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve();
          } else {
            const text = Buffer.concat(chunks).toString('utf8');
            reject(new Error(`relay ${path} → ${String(status)}: ${text}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

async function adminGet(path: string, portStr: string): Promise<string> {
  const port = Number.parseInt(portStr, 10);
  return new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'GET', path },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve(text);
          else reject(new Error(`relay ${path} → ${String(status)}: ${text}`));
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`agentbox-relay: ${msg}\n`);
  process.exit(1);
});
