/**
 * The half of `agentbox-ctl agent render <id>` that AgentBox keeps for itself:
 * WHICH overlay keys it is asserting on this run.
 *
 * The merge itself is delegated to the tool (`configRender.applyCmd`), so there
 * is deliberately no format parser and no 3-way merge engine here. What is left
 * is a diff between two overlays — the one in `agentbox.yaml` now, and the one
 * this command applied last time — and that diff is what decides whether an
 * in-box hand edit survives:
 *
 *   a key the user did NOT change in agentbox.yaml is not in the patch, the
 *   patch does not name it, and the tool leaves the file's value alone.
 *
 * Pure and disk-free so it can be unit-tested on values.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export function isPlainObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural equality, enough for parsed JSON/YAML values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

export interface OverlayPatch {
  /** The object sent to the tool's patch command on stdin. */
  patch: Record<string, JsonValue>;
  /** Dotted paths the patch touches, for the render's own output. */
  paths: string[];
  /** Dotted paths dropped from the overlay since the last apply. */
  removed: string[];
}

/**
 * Keys whose OVERLAY value changed since the last apply.
 *
 * A key the user REMOVED from `agentbox.yaml` is sent as `null`, because the
 * patch protocol reads null as "delete this path" and deletion is the only way
 * an overlay edit is reversible: without it, a value AgentBox once asserted
 * would be asserted forever and removing it from the yaml would do nothing. It
 * restores the tool's own default, not some AgentBox default — which is the
 * behaviour the overlay model promises.
 *
 * Arrays and scalars replace whole; only objects recurse. Element-wise merging
 * of a list whose entries have no identity produces results nobody predicts, and
 * the tool's own patch command makes the same choice.
 */
export function overlayPatch(previous: JsonValue | undefined, next: JsonValue): OverlayPatch {
  const paths: string[] = [];
  const removed: string[] = [];

  function walk(
    prev: Record<string, JsonValue> | undefined,
    cur: Record<string, JsonValue>,
    prefix: string,
  ): Record<string, JsonValue> {
    const out: Record<string, JsonValue> = {};
    const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(cur)]);
    for (const k of keys) {
      const path = prefix ? `${prefix}.${k}` : k;
      const before = prev?.[k];
      if (!Object.hasOwn(cur, k)) {
        out[k] = null;
        paths.push(path);
        removed.push(path);
        continue;
      }
      const after = cur[k] as JsonValue;
      if (before !== undefined && deepEqual(before, after)) continue;
      if (isPlainObject(before) && isPlainObject(after)) {
        const nested = walk(before, after, path);
        if (Object.keys(nested).length > 0) out[k] = nested;
        continue;
      }
      out[k] = after;
      paths.push(path);
    }
    return out;
  }

  const cur = isPlainObject(next) ? next : {};
  const prev = isPlainObject(previous) ? previous : undefined;
  return { patch: walk(prev, cur, ''), paths, removed };
}

/**
 * Keys and values that look like a real secret rather than a reference to one.
 *
 * A warning, never an error: the overlay is opaque to ctl, so this cannot be a
 * schema rule. But `agentbox.yaml` is a committed file, and a token pasted into
 * it is committed with it — the documented path is a `carry:` entry into a 0600
 * env file that the overlay references BY NAME.
 */
const SECRET_KEY_RE = /(secret|token|password|passwd|apikey|api_key|credential|private_key)/i;
/** Long opaque strings, and the vendor prefixes that are unambiguous on sight. */
const SECRET_VALUE_RES = [
  /^(sk|rk|pk)-[A-Za-z0-9_-]{16,}$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^xox[abposr]-[A-Za-z0-9-]{10,}$/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
  /^[0-9a-f]{40,}$/i,
];

/** A value that names a secret instead of being one is exactly what we want. */
function isReference(value: string): boolean {
  return value.includes('{{') || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value);
}

/**
 * Dotted paths under the overlay whose value looks like a literal secret.
 *
 * Exported for its own test: the rule is a heuristic, and a heuristic nobody can
 * see the boundaries of gets ignored the first time it cries wolf.
 */
export function lintOverlaySecrets(overlay: JsonValue, prefix = ''): string[] {
  const hits: string[] = [];
  if (Array.isArray(overlay)) {
    overlay.forEach((v, i) => hits.push(...lintOverlaySecrets(v, `${prefix}[${String(i)}]`)));
    return hits;
  }
  if (!isPlainObject(overlay)) return hits;
  for (const [k, v] of Object.entries(overlay)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' && !isReference(v)) {
      const keyLooksSecret = SECRET_KEY_RE.test(k) && v.length >= 8;
      if (keyLooksSecret || SECRET_VALUE_RES.some((re) => re.test(v))) hits.push(path);
      continue;
    }
    hits.push(...lintOverlaySecrets(v, path));
  }
  return hits;
}
