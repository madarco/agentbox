/**
 * The hub's LLM egress proxy (docs/llm-accounts-plan.md, Phase 7, `forward`).
 *
 * An HTTP CONNECT proxy on its own port. A box's in-box split proxy tunnels
 * ONLY its agent's model hosts here, so inference, OAuth refreshes and account
 * calls leave from the hub's IP. It never decrypts: after the CONNECT it is a
 * byte pipe.
 *
 * The port is reachable by boxes, so it is closed by default:
 *  - `Proxy-Authorization: Basic <boxId>:<credential>` where credential is
 *    `llmProxyCredential(relayToken)` (an HMAC of the box's relay token), 407
 *    otherwise. The hub leg is unencrypted TCP, so the relay token itself —
 *    the box's whole hub identity — never travels on it; nothing new is minted;
 *  - the destination must be one of the registry's `llmHosts`, on 443 (403
 *    otherwise) — it is not a general-purpose proxy.
 */
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { allAgentLlmHosts, llmProxyCredential } from '@agentbox/sandbox-core';

/** Constant-time check of a presented proxy credential against a relay token. */
export function llmProxyCredentialMatches(relayToken: string, presented: string): boolean {
  const want = Buffer.from(llmProxyCredential(relayToken), 'utf8');
  const got = Buffer.from(presented, 'utf8');
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Every agent's declared model hosts (`AgentSyncSpec.llmHosts`): the allowlist. */
export function llmProxyHosts(): readonly string[] {
  return allAgentLlmHosts();
}

export interface LlmProxyDeps {
  /** Whether `credential` is registered box `boxId`'s proxy credential. */
  authorize(boxId: string, credential: string): Promise<boolean>;
  /** The hosts a box may reach through the proxy (the registry's `llmHosts`). */
  allowedHosts(): readonly string[];
  log?: (msg: string) => void;
  /** Open the upstream connection (tests). Default: `net.connect`. */
  connect?: (port: number, host: string) => net.Socket;
}

/** Parse `Proxy-Authorization: Basic base64(boxId:credential)`. */
export function parseProxyAuth(
  header: string | undefined,
): { boxId: string; credential: string } | null {
  if (!header) return null;
  const m = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i <= 0 || i === decoded.length - 1) return null;
  return { boxId: decoded.slice(0, i), credential: decoded.slice(i + 1) };
}

/** `host:port` from a CONNECT request target, lowercased; null when malformed. */
export function parseConnectTarget(
  target: string | undefined,
): { host: string; port: number } | null {
  const m = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(target ?? '');
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1]!.toLowerCase(), port };
}

function reply(socket: net.Socket, status: string, reason: string, extra = ''): void {
  // The reason rides a header AND the body, so the agent's error names it.
  socket.end(
    `HTTP/1.1 ${status}\r\nX-Agentbox-Proxy-Reason: ${reason}\r\n${extra}Content-Length: ${String(Buffer.byteLength(reason))}\r\nConnection: close\r\n\r\n${reason}`,
  );
}

export function createLlmProxyServer(deps: LlmProxyDeps): http.Server {
  const log = deps.log ?? (() => {});
  const connect = deps.connect ?? ((port: number, host: string) => net.connect(port, host));
  const server = http.createServer((_req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('agentbox LLM proxy: CONNECT only');
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    void (async () => {
      const target = parseConnectTarget(req.url);
      if (!target) return reply(client, '400 Bad Request', 'malformed CONNECT target');
      const auth = parseProxyAuth(req.headers['proxy-authorization']);
      const boxId =
        auth && (await deps.authorize(auth.boxId, auth.credential).catch(() => false))
          ? auth.boxId
          : null;
      if (!boxId) {
        log(`llm-proxy: refused ${target.host} (no valid box credential)`);
        return reply(
          client,
          '407 Proxy Authentication Required',
          'agentbox LLM proxy: unknown box or wrong credential',
          'Proxy-Authenticate: Basic realm="agentbox"\r\n',
        );
      }
      if (target.port !== 443 || !deps.allowedHosts().includes(target.host)) {
        log(
          `llm-proxy: refused ${target.host}:${String(target.port)} for box ${boxId} (not an LLM host)`,
        );
        return reply(
          client,
          '403 Forbidden',
          `agentbox LLM proxy: ${target.host} is not an LLM host`,
        );
      }
      const upstream = connect(target.port, target.host);
      let established = false;
      upstream.once('connect', () => {
        established = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', (err) => {
        if (!established) {
          reply(
            client,
            '502 Bad Gateway',
            `agentbox LLM proxy: cannot reach ${target.host} (${err.message})`,
          );
        } else {
          client.destroy();
        }
      });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    })();
  });
  return server;
}
