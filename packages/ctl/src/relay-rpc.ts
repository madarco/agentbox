import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Shared HTTP RPC poster for in-box ctl commands (git, checkpoint, cp,
 * download). Mirrors the wire shape of `packages/relay/src/server.ts`'s
 * `/rpc`: bearer-auth POST with `{ method, params }`, response is a
 * `{ exitCode, stdout, stderr }` JSON or an `{ error }` shape.
 *
 * No client-side timeout: the relay holds the connection while a prompt
 * is open (per the "block indefinitely" design), so a 30s socket timeout
 * here would orphan the in-box command while the user thinks.
 */
export interface RelayRpcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PostRpcOptions {
  /** Override label used in error prefixes (default: 'agentbox-ctl rpc'). */
  errorPrefix?: string;
}

export interface PostRpcOutcome<TResult> {
  /** HTTP status the relay returned (0 on transport error). */
  status: number;
  /** Parsed JSON body when it matched TResult; null otherwise. */
  parsed: TResult | null;
  /** Raw response body (for diagnostics on parse failure). */
  raw: string;
  /** Internal exit code suggestion: 65 for env/URL errors, 126 for transport. */
  internalExitCode: number | null;
}

/**
 * Low-level: returns the raw outcome. Most callers want `postRpcAndExit`.
 */
export function postRpc<TParams>(
  method: string,
  params: TParams,
  opts: PostRpcOptions = {},
): Promise<PostRpcOutcome<RelayRpcResult>> {
  const prefix = opts.errorPrefix ?? 'agentbox-ctl rpc';
  const urlStr = process.env.AGENTBOX_RELAY_URL;
  const token = process.env.AGENTBOX_RELAY_TOKEN;
  if (!urlStr || !token) {
    process.stderr.write(
      `${prefix}: AGENTBOX_RELAY_URL / AGENTBOX_RELAY_TOKEN not set; no relay configured for this box.\n`,
    );
    return Promise.resolve({ status: 0, parsed: null, raw: '', internalExitCode: 65 });
  }
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    process.stderr.write(`${prefix}: invalid AGENTBOX_RELAY_URL: ${urlStr}\n`);
    return Promise.resolve({ status: 0, parsed: null, raw: '', internalExitCode: 65 });
  }

  const body = JSON.stringify({ method, params });
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? httpsRequest : httpRequest;
  const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;

  return new Promise<PostRpcOutcome<RelayRpcResult>>((resolve) => {
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
          let parsed: RelayRpcResult | null = null;
          try {
            const v = JSON.parse(text) as unknown;
            if (
              v &&
              typeof v === 'object' &&
              typeof (v as RelayRpcResult).exitCode === 'number'
            ) {
              parsed = v as RelayRpcResult;
            }
          } catch {
            parsed = null;
          }
          resolve({ status, parsed, raw: text, internalExitCode: null });
        });
      },
    );
    req.on('error', (err) => {
      process.stderr.write(`${prefix}: ${String(err.message ?? err)}\n`);
      resolve({ status: 0, parsed: null, raw: '', internalExitCode: 126 });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Convenience: POST + write stdout/stderr + return the exit code. Used by
 * every ctl subcommand that just forwards a relay RPC verbatim. Callers
 * `process.exit(await postRpcAndExit(...))`.
 *
 * Exit-code mapping:
 *  - parsed `{exitCode}` from relay → that value (incl. 10 = denied by user)
 *  - `internalExitCode` set on env/transport error → that value (65 / 126)
 *  - relay returned non-2xx with no parseable body → 1
 *  - relay returned 2xx with no parseable body → 0
 */
export async function postRpcAndExit<TParams>(
  method: string,
  params: TParams,
  opts: PostRpcOptions = {},
): Promise<number> {
  const prefix = opts.errorPrefix ?? 'agentbox-ctl rpc';
  const out = await postRpc(method, params, opts);
  if (out.internalExitCode !== null) return out.internalExitCode;
  if (out.parsed) {
    if (out.parsed.stdout) process.stdout.write(out.parsed.stdout);
    if (out.parsed.stderr) process.stderr.write(out.parsed.stderr);
    return out.parsed.exitCode;
  }
  process.stderr.write(`${prefix}: relay returned ${String(out.status)}: ${out.raw}\n`);
  return out.status >= 200 && out.status < 300 ? 0 : 1;
}
