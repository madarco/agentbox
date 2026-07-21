/**
 * Host egress-IP detection for the DigitalOcean firewall lock-down. Probes three
 * independent providers in sequence; first 3s success wins. Fails loud
 * (throws) if all three fail — we do **not** silently fall back to
 * `0.0.0.0/0`, because that would defeat the safe-by-default firewall.
 *
 * The user can always override the auto-detect via
 * `--firewall-source <cidr>` (or `--firewall-source 0.0.0.0/0` for the
 * explicit dynamic-IP opt-in).
 */

const PROBES = [
  'https://api.ipify.org',
  'https://ifconfig.io/ip',
  'https://icanhazip.com',
] as const;

const TIMEOUT_MS = 3_000;

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

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
 * Detect the host's egress IP. Returns the bare IP string (no `/32`); the
 * caller composes the CIDR.
 *
 * Throws when no probe responded. The error message lists each probe that
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
      errors.push(`${url}: empty/invalid response`);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `could not auto-detect the host's egress IP — all ${String(probes.length)} probes failed:\n` +
      errors.map((e) => `  - ${e}`).join('\n') +
      `\nOverride with --firewall-source <cidr> (e.g. --firewall-source 0.0.0.0/0 for the explicit-open opt-in).`,
  );
}

async function probe(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  const res = await fetchImpl(url, { method: 'GET' });
  if (!res.ok) return null;
  const body = (await res.text()).trim();
  if (IPV4_RE.test(body)) {
    // Cheap sanity: each octet in 0–255.
    const parts = body.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.every((p) => p >= 0 && p <= 255)) return body;
    return null;
  }
  // We do not currently use IPv6 for firewall rules (DigitalOcean accepts them
  // but the rest of the provider talks IPv4), but accept the probe answer
  // so a v6-only network surfaces an actionable error rather than a silent
  // empty result. Composing the CIDR is the caller's job.
  if (IPV6_RE.test(body) && body.includes(':')) return body;
  return null;
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
