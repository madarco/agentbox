/**
 * Per-agent pane-title cleanup, driven by the rules the host ships over
 * `agents.list` (`AgentSyncSpec.paneTitle`). Each TUI decorates its terminal
 * title differently (a status glyph, a ` | <cwd>` suffix, a placeholder before
 * the session has a name), and those decorations change with the agent's
 * version, which is why the rules are host data rather than baked here.
 */

export interface PaneTitleRules {
  strip: readonly RegExp[];
  /** Lower-cased. */
  placeholders: ReadonlySet<string>;
}

/**
 * Narrow and compile the wire rules. A pattern that fails to compile is dropped,
 * never thrown: the wire is untrusted input, and one bad rule must not cost the
 * agent its title. Undefined when nothing usable is left.
 */
export function parsePaneTitleRules(raw: unknown): PaneTitleRules | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as { strip?: unknown; placeholders?: unknown };
  const strip: RegExp[] = [];
  for (const src of Array.isArray(r.strip) ? r.strip : []) {
    if (typeof src !== 'string' || src.length === 0 || src.length > 500) continue;
    try {
      strip.push(new RegExp(src, 'u'));
    } catch {
      // dropped, see above
    }
  }
  const placeholders = new Set<string>();
  for (const p of Array.isArray(r.placeholders) ? r.placeholders : []) {
    if (typeof p === 'string' && p.trim().length > 0) placeholders.add(p.trim().toLowerCase());
  }
  if (strip.length === 0 && placeholders.size === 0) return undefined;
  return { strip, placeholders };
}

/** Apply the rules to an already-sanitized title; null when nothing meaningful remains. */
export function cleanPaneTitle(title: string, rules: PaneTitleRules | undefined): string | null {
  if (!rules) return title;
  let t = title;
  for (const re of rules.strip) t = t.replace(re, '');
  t = t.trim();
  if (t.length === 0 || rules.placeholders.has(t.toLowerCase())) return null;
  return t;
}
