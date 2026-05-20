import { Command } from 'commander';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

interface RpcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CheckpointParams {
  name?: string;
  merged?: boolean;
  setDefault?: boolean;
  replace?: boolean;
}

/**
 * Ask the host (via the relay) to capture this box as a project checkpoint.
 * The host owns snapshot storage + state.json + per-project config, so the
 * box never touches them directly — same channel as `agentbox-ctl git`.
 */
async function rpc(params: CheckpointParams): Promise<number> {
  const urlStr = process.env.AGENTBOX_RELAY_URL;
  const token = process.env.AGENTBOX_RELAY_TOKEN;
  if (!urlStr || !token) {
    process.stderr.write(
      'agentbox-ctl checkpoint: AGENTBOX_RELAY_URL / AGENTBOX_RELAY_TOKEN not set; no relay configured for this box.\n',
    );
    return 65;
  }
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    process.stderr.write(`agentbox-ctl checkpoint: invalid AGENTBOX_RELAY_URL: ${urlStr}\n`);
    return 65;
  }

  const body = JSON.stringify({ method: 'checkpoint.create', params });
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? httpsRequest : httpRequest;
  const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;

  return new Promise<number>((resolve) => {
    const req = transport(
      {
        host: url.hostname,
        port,
        method: 'POST',
        path: `${url.pathname.replace(/\/$/, '')}/rpc`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: RpcResult | null = null;
          try {
            parsed = JSON.parse(text) as RpcResult;
          } catch {
            parsed = null;
          }
          if (parsed && typeof parsed.exitCode === 'number') {
            if (parsed.stdout) process.stdout.write(parsed.stdout);
            if (parsed.stderr) process.stderr.write(parsed.stderr);
            resolve(parsed.exitCode);
            return;
          }
          process.stderr.write(
            `agentbox-ctl checkpoint: relay returned ${String(status)}: ${text}\n`,
          );
          resolve(status >= 200 && status < 300 ? 0 : 1);
        });
      },
    );
    req.on('error', (err) => {
      process.stderr.write(`agentbox-ctl checkpoint: ${String(err.message ?? err)}\n`);
      resolve(126);
    });
    req.write(body);
    req.end();
  });
}

export const checkpointCommand = new Command('checkpoint')
  .description('Capture this box as a project checkpoint (host-side, via the agentbox relay)')
  .option('--name <name>', 'checkpoint name (default: <box-name>-<next>)')
  .option('--merged', 'flatten lower+upper into one tree instead of a layered delta')
  .option('--set-default', 'mark this checkpoint as the project default for new boxes')
  .option(
    '--replace',
    "if a checkpoint with the same name exists, rm it first (idempotent recapture; safe to retry when the previous run's stdout was lost)",
  )
  .action(
    async (opts: { name?: string; merged?: boolean; setDefault?: boolean; replace?: boolean }) => {
      const params: CheckpointParams = {};
      if (opts.name) params.name = opts.name;
      if (opts.merged === true) params.merged = true;
      if (opts.setDefault === true) params.setDefault = true;
      if (opts.replace === true) params.replace = true;
      const code = await rpc(params);
      process.exit(code);
    },
  );
