/**
 * Hetzner name/label hygiene.
 *
 * The Cloud API rejects a label value or resource name longer than 63 characters,
 * or one that doesn't start and end alphanumeric ([-_.] allowed inside; resource
 * names additionally have to look like hostnames). A box name is user- or
 * workspace-derived, so it can legitimately blow past that — a control-box create
 * names boxes after its per-job clone directory (`agentbox-hub-worker-<uuid>-<id>`,
 * 66 chars), which failed the whole create with
 * `422 invalid_input: invalid input in field 'labels[agentbox.box]'` AFTER the
 * firewall call had gone out.
 *
 * These helpers make the box name safe at the API boundary. The `agentbox.box`
 * label is only ever read back for display (`list`, the firewall-sync hint) —
 * never used as a `label_selector` — so trimming it can't break a lookup.
 */

/** Hetzner's ceiling for both label values and resource names. */
export const HETZNER_MAX_NAME = 63;

/** Trim to `max` chars, then back off until it ends alphanumeric. */
function clampEnds(s: string, max: number): string {
  let out = s.slice(0, max);
  while (out.length > 0 && !/[a-zA-Z0-9]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/**
 * A Hetzner-legal label value for a box name: invalid characters collapse to `-`,
 * the result starts and ends alphanumeric and fits in 63 chars. Returns `''` when
 * nothing usable survives (an empty label value is valid, and callers fall back to
 * the sandbox id for display).
 */
export function hetznerLabelValue(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '');
  return clampEnds(cleaned, HETZNER_MAX_NAME);
}

/**
 * `<prefix>-<name>-<suffix>`, bounded to 63 chars. The prefix and suffix are kept
 * whole (they carry the meaning: what this is, and which create minted it) and the
 * name in the middle gives up characters as needed — a truncated name still reads
 * fine in the Hetzner console, whereas a truncated stamp would stop disambiguating.
 */
export function hetznerResourceName(prefix: string, name: string, suffix: string): string {
  const fixed = `${prefix}-`.length + `-${suffix}`.length;
  const budget = Math.max(0, HETZNER_MAX_NAME - fixed);
  const middle = clampEnds(hetznerLabelValue(name), budget);
  return middle.length > 0 ? `${prefix}-${middle}-${suffix}` : `${prefix}-${suffix}`;
}
