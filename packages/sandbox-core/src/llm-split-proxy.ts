/**
 * The in-box half of the hub egress proxy (docs/llm-accounts-plan.md, Phase 7).
 *
 * A tiny CONNECT proxy on `127.0.0.1:LLM_SPLIT_PROXY_PORT` that the agent alone
 * is pointed at (`HTTPS_PROXY`). The agent's model hosts are tunneled through
 * the hub's proxy (authenticated with the box's own relay token, read from the
 * env or `/run/agentbox/relay.env` — never handed to the agent's env), and
 * every other host goes direct. It never decrypts.
 *
 * Shipped on the launch command itself (base64), so a box on any provider and
 * any image gets it with no bake; `--ensure` makes the start idempotent.
 *
 * Fails closed but loud: when the hub is unreachable or refuses, the agent's
 * CONNECT gets a 502/407 whose body names the reason — the call fails, it never
 * silently leaves from the box's own IP.
 */
import type { LlmProxyRecord } from '@agentbox/core';

/** The split proxy's in-box port: unlikely to collide with a project's service. */
export const LLM_SPLIT_PROXY_PORT = 47290;

/** `host:port` the box dials; only these characters reach a shell. */
const UPSTREAM_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const HOST_RE = /^[a-z0-9.-]+$/;

export function isValidLlmProxyUpstream(s: string): boolean {
  if (!UPSTREAM_RE.test(s)) return false;
  const port = Number(s.slice(s.lastIndexOf(':') + 1));
  return port >= 1 && port <= 65535;
}

/** The script (CommonJS, Node built-ins only). argv: [--ensure] <port> <upstream> <hostsCsv>. */
export const LLM_SPLIT_PROXY_SCRIPT = String.raw`'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const MARK = 'agentbox-llm-split-proxy';
const args = process.argv.slice(2);
const ensure = args[0] === '--ensure';
if (ensure) args.shift();
const [portS, upstream, hostsCsv] = args;
const port = Number(portS);
const hosts = new Set(String(hostsCsv || '').split(',').filter(Boolean));
const uIdx = String(upstream || '').lastIndexOf(':');
const upHost = String(upstream).slice(0, uIdx);
const upPort = Number(String(upstream).slice(uIdx + 1));
if (!port || !upHost || !upPort) {
  process.stderr.write('agentbox llm proxy: usage: [--ensure] <port> <host:port> <hosts>\n');
  process.exit(2);
}

function probe(cb) {
  const req = http.get({ host: '127.0.0.1', port, path: '/__agentbox', timeout: 1000 }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => cb(b === MARK + ' ' + upstream + ' ' + hostsCsv));
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
}

if (ensure) {
  probe((ours) => {
    if (ours) process.exit(0);
    const log = path.join(os.homedir(), '.agentbox', 'llm-split-proxy.log');
    let fd = 'ignore';
    try { fd = fs.openSync(log, 'a'); } catch {}
    const child = require('child_process').spawn(process.execPath, [__filename, ...args], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    let tries = 0;
    const again = () => probe((up) => {
      if (up) process.exit(0);
      if (++tries >= 30) {
        process.stderr.write('agentbox llm proxy: did not come up on 127.0.0.1:' + port + ' (see ' + log + ')\n');
        process.exit(1);
      }
      setTimeout(again, 100);
    });
    setTimeout(again, 100);
  });
  return;
}

function token() {
  if (process.env.AGENTBOX_RELAY_TOKEN) return process.env.AGENTBOX_RELAY_TOKEN;
  try {
    const f = process.env.AGENTBOX_RELAY_ENV_FILE || '/run/agentbox/relay.env';
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && line.slice(0, i).trim() === 'AGENTBOX_RELAY_TOKEN') return line.slice(i + 1).trim();
    }
  } catch {}
  return '';
}

function fail(client, status, reason) {
  try {
    client.end('HTTP/1.1 ' + status + '\r\nX-Agentbox-Proxy-Reason: ' + reason + '\r\nContent-Length: ' +
      Buffer.byteLength(reason) + '\r\nConnection: close\r\n\r\n' + reason);
  } catch {}
}

function splice(client, up, head, rest) {
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (rest && rest.length) client.write(rest);
  if (head && head.length) up.write(head);
  up.pipe(client);
  client.pipe(up);
  client.on('close', () => up.destroy());
  up.on('close', () => client.destroy());
}

const server = http.createServer((req, res) => {
  if (req.url === '/__agentbox') { res.end(MARK + ' ' + upstream + ' ' + hostsCsv); return; }
  res.writeHead(405); res.end('CONNECT only');
});
server.on('connect', (req, client, head) => {
  client.on('error', () => {});
  const m = /^([A-Za-z0-9.-]+):(\d+)$/.exec(req.url || '');
  if (!m) return fail(client, '400 Bad Request', 'malformed CONNECT target');
  const host = m[1].toLowerCase();
  const p = Number(m[2]);
  if (!hosts.has(host)) {
    const s = net.connect(p, host);
    let ok = false;
    s.once('connect', () => { ok = true; splice(client, s, head); });
    s.on('error', (e) => { if (!ok) fail(client, '502 Bad Gateway', 'cannot reach ' + host + ': ' + e.message); else client.destroy(); });
    return;
  }
  const t = token();
  if (!t) return fail(client, '407 Proxy Authentication Required', 'agentbox LLM proxy: no relay token in this box');
  const s = net.connect(upPort, upHost);
  let buf = Buffer.alloc(0);
  let ok = false;
  s.once('connect', () => {
    s.write('CONNECT ' + host + ':' + p + ' HTTP/1.1\r\nHost: ' + host + ':' + p +
      '\r\nProxy-Authorization: Basic ' + Buffer.from('agentbox:' + t).toString('base64') + '\r\n\r\n');
  });
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) { if (buf.length > 16384) { s.destroy(); fail(client, '502 Bad Gateway', 'agentbox LLM proxy: bad answer from the hub'); } return; }
    s.removeListener('data', onData);
    const status = buf.slice(0, buf.indexOf('\r\n')).toString();
    if (/^HTTP\/1\.[01] 200/.test(status)) { ok = true; splice(client, s, head, buf.slice(end + 4)); return; }
    // The hub refused (407 unknown token, 403 not an LLM host, 502 upstream):
    // pass its answer through, so the agent's error names the reason.
    client.end(buf);
    s.destroy();
  };
  s.on('data', onData);
  s.on('error', (e) => {
    if (!ok) fail(client, '502 Bad Gateway', 'agentbox LLM proxy: hub proxy ' + upstream + ' unreachable (' + e.message + ')');
    else client.destroy();
  });
});
server.on('error', (e) => { process.stderr.write('agentbox llm proxy: ' + e.message + '\n'); process.exit(1); });
server.listen(port, '127.0.0.1');
`;

/**
 * The shell preamble that starts the split proxy and points the agent at it,
 * for an agent launch command — or '' when the box has no proxy or the agent
 * declares no model hosts. Uses no single quote, so it is safe both as a
 * `sh -c` string (docker) and inside the cloud launcher's `bash -lc '…'`.
 * When the proxy cannot start, the launch stops with the reason instead of
 * letting the agent run unproxied.
 */
export function llmProxyLaunchPreamble(
  record: LlmProxyRecord | undefined,
  llmHosts: readonly string[] | undefined,
): string {
  if (!record || record.mode !== 'forward' || !llmHosts || llmHosts.length === 0) return '';
  if (!isValidLlmProxyUpstream(record.upstream)) {
    throw new Error(`invalid LLM proxy upstream '${record.upstream}' (expected host:port)`);
  }
  for (const h of llmHosts) if (!HOST_RE.test(h)) throw new Error(`invalid LLM host '${h}'`);
  const b64 = Buffer.from(LLM_SPLIT_PROXY_SCRIPT, 'utf8').toString('base64');
  const port = String(LLM_SPLIT_PROXY_PORT);
  const local = `http://127.0.0.1:${port}`;
  return (
    `F="$HOME/.agentbox/llm-split-proxy.cjs"; mkdir -p "$HOME/.agentbox" && ` +
    `echo ${b64} | base64 -d > "$F" && ` +
    `node "$F" --ensure ${port} ${record.upstream} ${llmHosts.join(',')} || ` +
    `{ echo "agentbox: the LLM proxy did not start, so the agent was not launched (llm.proxy=forward via ${record.upstream})"; sleep 15; exit 1; }; ` +
    `export HTTPS_PROXY=${local} https_proxy=${local} NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1; `
  );
}

/** The `llm.*` config keys the resolver reads (this machine's effective config). */
export interface LlmProxyConfig {
  proxy: 'off' | 'forward';
  proxyPort: number;
  proxyUrl: string;
}

/**
 * Resolve a create's `llm.proxy` into the record the box carries, or undefined
 * for `off` (llm-accounts Phase 7). `mode` is the caller's override (flag, API
 * `opts.llmProxy`); else the config's. A local docker box reaches the hub at
 * `host.docker.internal:<proxyPort>`; every other provider (cloud, and
 * remote-docker on another machine) needs `llm.proxyUrl`, and a create without
 * it is refused rather than silently sent direct.
 */
export function resolveLlmProxyRecord(
  providerName: string,
  cfg: LlmProxyConfig,
  mode: 'off' | 'forward' | undefined = undefined,
): LlmProxyRecord | undefined {
  const effective = mode ?? cfg.proxy;
  if (effective !== 'forward') return undefined;
  const upstream =
    providerName === 'docker'
      ? `host.docker.internal:${String(cfg.proxyPort)}`
      : cfg.proxyUrl
          .trim()
          .replace(/^[a-z]+:\/\//i, '')
          .replace(/\/+$/, '');
  if (!upstream) {
    throw new Error(
      `llm.proxy=forward on a ${providerName} box needs llm.proxyUrl: the host:port where this hub's LLM proxy (llm.proxyPort ${String(cfg.proxyPort)}) is reachable from the internet. Set it, or create with --llm-proxy off.`,
    );
  }
  if (!isValidLlmProxyUpstream(upstream)) {
    throw new Error(`llm.proxyUrl must be host:port (got '${cfg.proxyUrl}')`);
  }
  return { mode: 'forward', upstream };
}
