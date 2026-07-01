import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { relayEnvFilePath, resolveRelayEnv } from './relay-env.js';

/**
 * Shared HTTP RPC poster for in-box ctl commands (git, checkpoint, cp,
 * download). Mirrors the wire shape of `packages/relay/src/server.ts`'s
 * `/rpc`: bearer-auth POST with `{ method, params }`, response is a
 * `{ exitCode, stdout, stderr }` JSON or an `{ error }` shape.
 *
 * Two relay shapes are supported transparently:
 *   - block mode (laptop relay): the relay holds the connection while a prompt
 *     is open, then returns the `{exitCode,…}` result. No client timeout.
 *   - poll mode (hosted control plane): the relay replies `202 {promptId}` and
 *     this client polls `GET /rpc/status/:promptId` until the host answers.
 * A box never has to know which mode it's talking to.
 */
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_MS = 10 * 60 * 1000; // give a human ~10 min to answer before giving up
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
interface RelayTarget {
  url: URL;
  token: string;
  transport: typeof httpRequest;
  port: number;
}

/** Resolve the relay endpoint from env or the 0600 relay.env file, or null (after writing the error). */
function resolveRelayTarget(prefix: string): RelayTarget | null {
  const { url: urlStr, token } = resolveRelayEnv();
  if (!urlStr || !token) {
    process.stderr.write(
      `${prefix}: AGENTBOX_RELAY_URL / AGENTBOX_RELAY_TOKEN not set (and ${relayEnvFilePath()} absent); no relay configured for this box.\n`,
    );
    return null;
  }
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    process.stderr.write(`${prefix}: invalid AGENTBOX_RELAY_URL: ${urlStr}\n`);
    return null;
  }
  const isHttps = url.protocol === 'https:';
  return {
    url,
    token,
    transport: isHttps ? httpsRequest : httpRequest,
    port: url.port.length > 0 ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80,
  };
}

function parseRpcResult(text: string): RelayRpcResult | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && typeof (v as RelayRpcResult).exitCode === 'number') {
      return v as RelayRpcResult;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function postRpc<TParams>(
  method: string,
  params: TParams,
  opts: PostRpcOptions = {},
): Promise<PostRpcOutcome<RelayRpcResult>> {
  const prefix = opts.errorPrefix ?? 'agentbox-ctl rpc';
  const target = resolveRelayTarget(prefix);
  if (!target) return Promise.resolve({ status: 0, parsed: null, raw: '', internalExitCode: 65 });

  const body = JSON.stringify({ method, params });

  return new Promise<PostRpcOutcome<RelayRpcResult>>((resolve) => {
    const req = target.transport(
      {
        host: target.url.hostname,
        port: target.port,
        method: 'POST',
        path: `${target.url.pathname.replace(/\/$/, '')}/rpc`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
          Authorization: `Bearer ${target.token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status, parsed: parseRpcResult(text), raw: text, internalExitCode: null });
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

interface RpcStatusReply {
  /** 'pending' while awaiting the host answer; 'done' once resolved. */
  status?: 'pending' | 'done';
  result?: RelayRpcResult;
}

/** GET /rpc/status/:promptId once. Returns null + writes the error on transport failure. */
function getRpcStatus(promptId: string, prefix: string): Promise<RpcStatusReply | null> {
  const target = resolveRelayTarget(prefix);
  if (!target) return Promise.resolve(null);
  return new Promise<RpcStatusReply | null>((resolve) => {
    const req = target.transport(
      {
        host: target.url.hostname,
        port: target.port,
        method: 'GET',
        path: `${target.url.pathname.replace(/\/$/, '')}/rpc/status/${encodeURIComponent(promptId)}`,
        headers: { Authorization: `Bearer ${target.token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcStatusReply);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
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
/**
 * POST + (on a 202, poll /rpc/status) → the final `{exitCode,stdout,stderr}`,
 * WITHOUT writing stdout/stderr. Callers that just forward use
 * {@link postRpcAndExit}; callers that need to consume the result body (e.g.
 * `git.lease-token`, whose stdout is the lease JSON) use this directly.
 */
export async function postRpcAwait<TParams>(
  method: string,
  params: TParams,
  opts: PostRpcOptions = {},
): Promise<RelayRpcResult> {
  const prefix = opts.errorPrefix ?? 'agentbox-ctl rpc';
  const out = await postRpc(method, params, opts);
  if (out.internalExitCode !== null) {
    // postRpc already wrote the env/transport error to stderr.
    return { exitCode: out.internalExitCode, stdout: '', stderr: '' };
  }
  if (out.status === 202) return pollParkedResult(out.raw, prefix);
  if (out.parsed) return out.parsed;
  if (out.status >= 200 && out.status < 300) return { exitCode: 0, stdout: '', stderr: '' };
  return {
    exitCode: 1,
    stdout: '',
    stderr: `${prefix}: relay returned ${String(out.status)}: ${out.raw}\n`,
  };
}

export async function postRpcAndExit<TParams>(
  method: string,
  params: TParams,
  opts: PostRpcOptions = {},
): Promise<number> {
  const result = await postRpcAwait(method, params, opts);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

/** Poll /rpc/status until the host answers the parked approval; return the result. */
async function pollParkedResult(raw202: string, prefix: string): Promise<RelayRpcResult> {
  let promptId = '';
  try {
    const v = JSON.parse(raw202) as { promptId?: unknown };
    if (typeof v.promptId === 'string') promptId = v.promptId;
  } catch {
    /* handled below */
  }
  if (!promptId) {
    return { exitCode: 1, stdout: '', stderr: `${prefix}: relay parked the action but returned no promptId\n` };
  }
  process.stderr.write(`${prefix}: waiting for approval on the host…\n`);
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS + Math.floor(Math.random() * 400));
    const reply = await getRpcStatus(promptId, prefix);
    if (reply && reply.status === 'done' && reply.result) {
      return reply.result;
    }
    // null (transient transport error) or pending → keep polling.
  }
  return { exitCode: 124, stdout: '', stderr: `${prefix}: timed out waiting for host approval\n` };
}
