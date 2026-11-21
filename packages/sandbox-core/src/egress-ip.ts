/**
 * Host egress-IP detection for the VPS providers' firewall lock-down
 * (hetzner, digitalocean). The host reaches a box over the VPS's public IPv4,
 * so the firewall must admit the host's IPv4 egress. Two things make that
 * hold on a dual-stack host:
 *
 *   - every probe connects over IPv4 only (`family: 4`), so a dual-stack
 *     "what is my IP" endpoint sees, and echoes back, the IPv4 egress;
 *   - only a valid IPv4 answer is accepted. An IPv6 answer falls through to
 *     the next probe instead of becoming a bogus `<v6>/32` rule that the
 *     cloud API rejects (Hetzner: 422 `rules[].source_ips`).
 *
 * Fails loud when no probe yields an IPv4 address. We never fall back to
 * `0.0.0.0/0`: that would silently defeat the safe-by-default firewall.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const PROBES = [
  'https://api4.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://ifconfig.io/ip',
] as const;

const TIMEOUT_MS = 3_000;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export interface ProbeResponse {
  status: number;
  body: string;
}

/** Fetch `url` over IPv4 only. Injected by tests. */
export type EgressProbeGet = (url: string, timeoutMs: number) => Promise<ProbeResponse>;

export interface DetectEgressIpOptions {
  /** Override the probe list (tests inject this). */
  probes?: readonly string[];
  /** Per-probe timeout in ms (default 3_000). */
  timeoutMs?: number;
  /** Override the IPv4-only HTTP GET (tests inject this). */
  get?: EgressProbeGet;
  /** Best-effort logger for probe attempts. */
  onLog?: (line: string) => void;
  /**
   * How the user can bypass detection, appended to the failure message
   * (e.g. the provider's `AGENTBOX_<PROVIDER>_FIREWALL_SOURCE` env var).
   */
  overrideHint?: string;
}

/** True for a dotted-quad IPv4 address with every octet in 0-255. */
export function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  if (!m) return false;
  return m.slice(1).every((o) => Number.parseInt(o, 10) <= 255);
}

/**
 * Detect the host's IPv4 egress address. Returns the bare IP (no `/32`); use
 * {@link detectEgressCidr} for the firewall-ready form.
 *
 * Throws when no probe returned an IPv4 address; the message lists what each
 * probe did so the user can tell a blocked network from an IPv6-only one.
 */
export async function detectEgressIp(opts: DetectEgressIpOptions = {}): Promise<string> {
  const probes = opts.probes ?? PROBES;
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  const get = opts.get ?? getOverIpv4;
  const errors: string[] = [];

  for (const url of probes) {
    try {
      const res = await raceTimeout(get(url, timeout), timeout);
      if (res.status < 200 || res.status >= 300) {
        errors.push(`${url}: HTTP ${String(res.status)}`);
        continue;
      }
      const body = res.body.trim();
      if (isIpv4(body)) {
        opts.onLog?.(`egress-ip: detected ${body} via ${url}`);
        return body;
      }
      errors.push(
        body.includes(':')
          ? `${url}: answered with a non-IPv4 address (${body.slice(0, 64)})`
          : `${url}: empty/invalid response`,
      );
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `could not auto-detect the host's IPv4 egress address — all ${String(probes.length)} probes failed:\n` +
      errors.map((e) => `  - ${e}`).join('\n') +
      '\nThe box firewall needs the IPv4 address the host uses to reach the VPS; an IPv6-only host cannot be locked down by IP.' +
      (opts.overrideHint ? `\n${opts.overrideHint}` : ''),
  );
}

/** {@link detectEgressIp} as a single-host firewall source (`<ipv4>/32`). */
export async function detectEgressCidr(opts: DetectEgressIpOptions = {}): Promise<string> {
  return `${await detectEgressIp(opts)}/32`;
}

/**
 * GET over IPv4 only. `fetch` can't pin the address family without pulling in
 * undici's Agent, so this uses node:http(s) with `family: 4`, which makes the
 * DNS lookup return A records only.
 */
export const getOverIpv4: EgressProbeGet = (url, timeoutMs) =>
  new Promise<ProbeResponse>((resolve, reject) => {
    const target = new URL(url);
    const request = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = request(target, { method: 'GET', family: 4, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        // An IP is a few bytes; cap a misbehaving endpoint.
        if (body.length < 4096) body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`probe timed out after ${String(timeoutMs)}ms`)));
    req.on('error', reject);
    req.end();
  });

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timed out after ${String(ms)}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
