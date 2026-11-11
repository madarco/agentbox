/**
 * Host egress IPv4 detection for the DigitalOcean firewall lock-down. Probes three
 * independent providers in sequence; first 3s success wins. Fails loud
 * (throws) if all three fail — we do **not** silently fall back to
 * `0.0.0.0/0`, because that would defeat the safe-by-default firewall.
 *
 * The user can always override the auto-detect via
 * `--firewall-source <cidr>` (or `--firewall-source 0.0.0.0/0` for the
 * explicit dynamic-IP opt-in).
 */

import { isIPv4 } from 'node:net';

const PROBES = [
  'https://api.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://4.ident.me',
] as const;

const TIMEOUT_MS = 3_000;

export interface DetectEgressIpOptions {
  /** Override the probe list (tests inject this). */
  probes?: readonly string[];
  /** Per-probe timeout in ms (default 3_000). */
  timeoutMs?: number;
  /** Override `fetch` (tests inject this). */
  fetchImpl?: typeof fetch;
  /** Best-effort logger for probe attempts. */
  onLog?: (line: string) => void;
}

/**
 * Detect the host's egress IPv4. Returns the bare IP string (no `/32`); the
 * caller composes the CIDR.
 *
 * Throws when no probe returns IPv4. The error message lists each probe that
 * was tried so the user can see whether their network is blocking a
 * specific provider.
 */
export async function detectEgressIp(opts: DetectEgressIpOptions = {}): Promise<string> {
  const probes = opts.probes ?? PROBES;
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const errors: string[] = [];

  for (const url of probes) {
    try {
      const ip = await raceTimeout(probe(url, fetchImpl), timeout);
      if (ip) {
        opts.onLog?.(`egress-ip: detected ${ip} via ${url}`);
        return ip;
      }
      errors.push(`${url}: empty/invalid IPv4 response`);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `could not auto-detect the host's egress IPv4 — all ${String(probes.length)} probes failed:\n` +
      errors.map((e) => `  - ${e}`).join('\n') +
      `\nOverride with --firewall-source <cidr> (e.g. --firewall-source 0.0.0.0/0 for the explicit-open opt-in).`,
  );
}

async function probe(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  const res = await fetchImpl(url, { method: 'GET' });
  if (!res.ok) return null;
  const body = (await res.text()).trim();
  return isIPv4(body) ? body : null;
}

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
