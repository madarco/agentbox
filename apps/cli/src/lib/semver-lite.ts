/**
 * Minimal semver comparison for the npm update nudge and the tray-app version
 * compare. Dependency-free on purpose — this runs on the CLI's startup path.
 *
 * Prerelease ordering is NOT optional here: the nightly channel publishes
 * `0.28.0-nightly.<stamp>` versions, and the whole channel design rests on two
 * comparisons this file has to get right —
 *
 *   0.28.0-nightly.6 > 0.28.0-nightly.5   (a newer nightly supersedes an older one)
 *   0.28.0           > 0.28.0-nightly.6   (the release supersedes every nightly before it)
 *
 * The second is what lets a stable release reach nightly testers automatically.
 * Get either wrong and nothing errors — testers just silently stop receiving
 * updates. See docs/nightly-channel-plan.md.
 *
 * Build metadata (`+sha`) is ignored, per the spec: it carries no precedence.
 *
 * `0.0.0` is the dev-build sentinel (`0.0.0-dev`, set when the CLI runs from a
 * checkout) and is deliberately treated as UNCOMPARABLE rather than as the
 * lowest version, so a dev build never reads as newer *or* older than a
 * release. `install-app.ts`'s `isReleaseVersion` and the tray's Swift mirror
 * carry the same exclusion.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Parsed {
  core: [number, number, number];
  /** Dot-separated prerelease identifiers; empty for a plain release. */
  pre: string[];
}

function parse(v: string): Parsed | null {
  const m = VERSION.exec(v.trim());
  if (!m) return null;
  const core: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (core[0] === 0 && core[1] === 0 && core[2] === 0) return null; // dev sentinel
  const raw = m[4];
  const pre = raw === undefined || raw === '' ? [] : raw.split('.');
  if (pre.some((id) => id === '')) return null; // "1.2.3-a..b" is not valid semver
  return { core, pre };
}

/**
 * Semver identifier precedence: numeric identifiers compare numerically,
 * everything else ASCII-lexically, and a numeric identifier always ranks BELOW
 * an alphanumeric one.
 */
function compareIdentifiers(a: string, b: string): -1 | 0 | 1 {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const na = Number(a);
    const nb = Number(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** -1 / 0 / 1, or null when either side isn't a comparable version. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;

  for (let i = 0; i < 3; i++) {
    const ai = pa.core[i] as number;
    const bi = pb.core[i] as number;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }

  // Equal cores: a release outranks any prerelease of the same version.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;

  const shared = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < shared; i++) {
    const c = compareIdentifiers(pa.pre[i] as string, pb.pre[i] as string);
    if (c !== 0) return c;
  }
  // A longer identifier list wins when it shares the shorter one's prefix.
  return pa.pre.length < pb.pre.length ? -1 : pa.pre.length > pb.pre.length ? 1 : 0;
}

/** True when `latest` is a strictly newer release than `current`. */
export function isNewer(latest: string | undefined, current: string): boolean {
  if (latest === undefined) return false;
  return compareSemver(latest, current) === 1;
}
