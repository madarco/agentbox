/**
 * Minimal x.y.z comparison for the npm update nudge. The registry's `latest`
 * dist-tag is always a plain triplet, so a dependency-free compare suffices.
 * Anything unparseable (or the dev build `0.0.0-dev`) never reads as newer.
 */

const TRIPLET = /^(\d+)\.(\d+)\.(\d+)$/;

function parseTriplet(v: string): [number, number, number] | null {
  const m = TRIPLET.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseTriplet(a);
  const pb = parseTriplet(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] as number;
    const bi = pb[i] as number;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

/** True when `latest` is a strictly newer release than `current`. */
export function isNewer(latest: string | undefined, current: string): boolean {
  if (latest === undefined) return false;
  return compareSemver(latest, current) === 1;
}
