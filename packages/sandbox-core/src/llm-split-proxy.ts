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
import { AGENT_SYNC_SPECS } from './sync/registry.js';

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

// cb(state): 'ours' (same config), 'stale' (our proxy, other config), 'none'.
function probe(cb) {
  let done = false;
  const once = (v) => { if (!done) { done = true; cb(v); } };
  const req = http.get({ host: '127.0.0.1', port, path: '/__agentbox', timeout: 1000 }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () =>
      once(b === MARK + ' ' + upstream + ' ' + hostsCsv ? 'ours' : b.startsWith(MARK) ? 'stale' : 'none'));
  });
  req.on('error', () => once('none'));
  req.on('timeout', () => { req.destroy(); once('none'); });
}

function stopStale(cb) {
  const req = http.request({ host: '127.0.0.1', port, path: '/__agentbox/exit', method: 'POST', timeout: 1000 }, (res) => {
    res.resume();
    res.on('end', () => setTimeout(cb, 200));
  });
  req.on('error', () => setTimeout(cb, 200));
  req.on('timeout', () => { req.destroy(); });
  req.end();
}

function start() {
    const log = path.join(os.homedir(), '.agentbox', 'llm-split-proxy.log');
    let fd = 'ignore';
    try { fd = fs.openSync(log, 'a'); } catch {}
    const child = require('child_process').spawn(process.execPath, [__filename, ...args], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    let tries = 0;
    const again = () => probe((state) => {
      if (state === 'ours') process.exit(0);
      if (++tries >= 30) {
        process.stderr.write('agentbox llm proxy: did not come up on 127.0.0.1:' + port + ' (see ' + log + ')\n');
        process.exit(1);
      }
      setTimeout(again, 100);
    });
    setTimeout(again, 100);
}

if (ensure) {
  // A proxy of ours with another config (an upgrade changed the host list):
  // replace it, or the new one could never bind the port.
  probe((state) => {
    if (state === 'ours') process.exit(0);
    if (state === 'stale') stopStale(start);
    else start();
  });
  return;
}

// The relay.env file first: it is rewritten on a re-registration, while this
// process's env was frozen when it started. The env covers docker boxes.
function token() {
  try {
    const f = process.env.AGENTBOX_RELAY_ENV_FILE || '/run/agentbox/relay.env';
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && line.slice(0, i).trim() === 'AGENTBOX_RELAY_TOKEN') {
        const v = line.slice(i + 1).trim();
        if (v) return v;
      }
    }
  } catch {}
  return process.env.AGENTBOX_RELAY_TOKEN || '';
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
  if (req.url === '/__agentbox/exit' && req.method === 'POST') { res.end('bye', () => process.exit(0)); return; }
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
  s.on('close', () => {
    if (!ok && !client.destroyed && !client.writableEnded) {
      fail(client, '502 Bad Gateway', 'agentbox LLM proxy: hub proxy ' + upstream + ' closed the connection without answering');
    }
  });
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
    `export HTTPS_PROXY=${local} https_proxy=${local} ` +
    `NO_PROXY="localhost,127.0.0.1\${NO_PROXY:+,\$NO_PROXY}" no_proxy="localhost,127.0.0.1\${no_proxy:+,\$no_proxy}"; `
  );
}

/** The `llm.*` config keys, read from THIS machine's global config. */
export interface LlmProxyConfig {
  proxy: 'off' | 'forward';
  proxyPort: number;
  proxyUrl: string;
}

/**
 * Whether this machine's hub/relay runs the LLM CONNECT listener: only once
 * the user opted in here (`llm.proxy: forward` globally, or `llm.proxyUrl`
 * set), so a machine that never uses the feature opens no extra port.
 */
export function llmProxyListenerEnabled(host: LlmProxyConfig): boolean {
  return host.proxy === 'forward' || host.proxyUrl.trim() !== '';
}

/** Every agent's declared model hosts: the split proxy's and the hub's allowlist. */
export function allAgentLlmHosts(): string[] {
  return [...new Set(AGENT_SYNC_SPECS.flatMap((s) => s.llmHosts ?? []))];
}

/**
 * Resolve a create's LLM proxy into the record the box carries, or undefined
 * for `off` (llm-accounts Phase 7). `mode` is the caller's choice (flag, API
 * `opts.llmProxy`, else the project's `llm.proxy`); `host` is THIS machine's
 * GLOBAL `llm.*` (the listener's port and public address are the machine's,
 * never a project's). A local docker box reaches the hub at
 * `host.docker.internal:<proxyPort>`; every other provider (cloud, and
 * remote-docker on another machine) needs `llm.proxyUrl`. Refused, rather than
 * silently sent direct, when the listener is off here or the URL is missing.
 */
export function resolveLlmProxyRecord(
  providerName: string,
  host: LlmProxyConfig,
  mode: 'off' | 'forward' | undefined = undefined,
): LlmProxyRecord | undefined {
  const effective = mode ?? host.proxy;
  if (effective !== 'forward') return undefined;
  if (!llmProxyListenerEnabled(host)) {
    throw new Error(
      "this machine's hub does not run the LLM proxy: enable it with `agentbox config set llm.proxy forward` (global) or set llm.proxyUrl, then restart the hub",
    );
  }
  const upstream =
    providerName === 'docker'
      ? `host.docker.internal:${String(host.proxyPort)}`
      : host.proxyUrl
          .trim()
          .replace(/^[a-z]+:\/\//i, '')
          .replace(/\/+$/, '');
  if (!upstream) {
    throw new Error(
      `llm.proxy=forward on a ${providerName} box needs llm.proxyUrl: the host:port where this hub's LLM proxy (llm.proxyPort ${String(host.proxyPort)}) is reachable from the internet. Set it, or create with --llm-proxy off.`,
    );
  }
  if (!isValidLlmProxyUpstream(upstream)) {
    throw new Error(`llm.proxyUrl must be host:port (got '${host.proxyUrl}')`);
  }
  return { mode: 'forward', upstream };
}
