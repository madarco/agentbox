/**
 * Edge redaction for transcripts (docs/agent-history-plan.md, Phase 0 "Redaction").
 *
 * Exact secret values the edge knows, plus a curated list of known formats with
 * the placeholder / reference / local-dev filters. No free-floating entropy rule:
 * Phase 0 measured ~1.1M false flags a week for one. Entropy is checked only on
 * the VALUE side of a `KEY=` / `KEY:` assignment.
 *
 * Length-preserving: a match becomes `[REDACTED:<kind>]` padded with `*` to the
 * same byte length (or all `*` when shorter), so a file offset means the same
 * thing raw and redacted. Works on latin1 strings so one char is one byte; every
 * pattern's classes stay inside ASCII so a UTF-8 sequence is never split.
 */

export interface Redactor {
  redact(bytes: Uint8Array): { bytes: Uint8Array; hits: number };
}

const MIN_EXACT_SECRET = 8;

function mask(kind: string, len: number): string {
  const label = `[REDACTED:${kind}]`;
  return label.length <= len ? label + '*'.repeat(len - label.length) : '*'.repeat(len);
}

const PLACEHOLDER =
  /^(?:x+|\*+|\.+|changeme|change-me|password|passwd|pass|secret|token|redacted|example|test|dummy|placeholder|your[-_a-z]*|my[-_a-z]*|<[^>]*>|\{[^}]*\}|\[[^\]]*\])$/i;
const ENV_REFERENCE = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_]+%|process\.env\..*|env\..*)$/;

function shannon(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A value that is plausibly a secret: not a placeholder, reference, path or identifier. */
export function looksLikeSecretValue(v: string): boolean {
  if (v.length < 12) return false;
  if (PLACEHOLDER.test(v) || ENV_REFERENCE.test(v)) return false;
  if (v.includes('/') || v.startsWith('.') || v.startsWith('~')) return false;
  if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
  // snake/kebab/camel identifiers (`get_user_token`, `refresh-token-v2`).
  if (/^[a-z]+(?:[-_.][a-z0-9]+)*$/.test(v)) return false;
  return shannon(v) >= 3.5;
}

const LOCAL_HOST =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(?::\d+)?$/i;

interface FormatRule {
  kind: string;
  re: RegExp;
  /** Capture group holding the value to mask (default: whole match). */
  group?: number;
  /** Return false to keep the match (a filter hit). */
  keep?: (m: RegExpExecArray) => boolean;
}

// Value-only formats: the prefix alone makes these near-certain.
const FORMATS: FormatRule[] = [
  { kind: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai', re: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'slack', re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'stripe', re: /\b[rs]k_live_[0-9A-Za-z]{20,}/g },
  { kind: 'npm', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'daytona', re: /\bdtn_[A-Za-z0-9]{32,}/g },
  { kind: 'e2b', re: /\be2b_[A-Za-z0-9]{30,}/g },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    // In a JSONL line the key's newlines are the two characters `\n`, so the
    // body never spans a real newline: crossing one would mask whole lines.
    kind: 'private-key',
    re: /-----BEGIN ([A-Z ]{0,20})PRIVATE KEY-----([^\n]{16,}?)-----END \1PRIVATE KEY-----/g,
    group: 2,
  },
];

// Compound formats: the key name decides, the value goes through the filters.
const COMPOUND: FormatRule[] = [
  {
    kind: 'bearer',
    re: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/g,
    group: 2,
    keep: (m) => !PLACEHOLDER.test(m[2]!) && !ENV_REFERENCE.test(m[2]!),
  },
  {
    kind: 'url-password',
    re: /\b[a-z][a-z0-9+.-]{1,15}:\/\/[A-Za-z0-9._~%!$&'()*+,;=-]{1,64}:([A-Za-z0-9._~%!$&'()*+,;=-]{1,128})@([A-Za-z0-9.[\]:-]{1,255})/g,
    group: 1,
    keep: (m) => !PLACEHOLDER.test(m[1]!) && !ENV_REFERENCE.test(m[1]!) && !LOCAL_HOST.test(m[2]!),
  },
  {
    kind: 'assignment',
    re: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?)(\\?["']?\s*[=:]\s*\\?["']?)([A-Za-z0-9._~+/=-]{12,})/gi,
    group: 3,
    keep: (m) => looksLikeSecretValue(m[3]!),
  },
];

/** Span of capture group `g` (rules are compiled with the `d` flag). */
function groupSpan(m: RegExpExecArray, g: number | undefined): [number, number] {
  const indices = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> })
    .indices;
  const span = g ? indices?.[g] : undefined;
  return span ?? [m.index, m.index + m[0].length];
}

const withIndices = (rules: FormatRule[]): FormatRule[] =>
  rules.map((r) => ({ ...r, re: new RegExp(r.re.source, `${r.re.flags}d`) }));

const RULES = withIndices([...FORMATS, ...COMPOUND]);

export function createRedactor(opts: { secrets?: Iterable<string> } = {}): Redactor {
  const exact = [...new Set(opts.secrets ?? [])]
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_EXACT_SECRET && /^[\x20-\x7e]+$/.test(s))
    // Longest first, so a secret containing a shorter one is masked whole.
    .sort((a, b) => b.length - a.length);

  return {
    redact(bytes) {
      let text = Buffer.from(bytes).toString('latin1');
      let hits = 0;
      for (const s of exact) {
        if (!text.includes(s)) continue;
        const parts = text.split(s);
        hits += parts.length - 1;
        text = parts.join(mask('secret', s.length));
      }
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        const spans: Array<[number, number]> = [];
        let m: RegExpExecArray | null;
        while ((m = rule.re.exec(text)) !== null) {
          if (m[0].length === 0) {
            rule.re.lastIndex++;
            continue;
          }
          if (m[0].includes('[REDACTED:')) continue;
          if (rule.keep && !rule.keep(m)) continue;
          spans.push(groupSpan(m, rule.group));
        }
        for (let i = spans.length - 1; i >= 0; i--) {
          const [a, b] = spans[i]!;
          text = text.slice(0, a) + mask(rule.kind, b - a) + text.slice(b);
          hits++;
        }
      }
      return hits === 0 ? { bytes, hits } : { bytes: Buffer.from(text, 'latin1'), hits };
    },
  };
}

/**
 * Secret-shaped values from an environment: anything under a KEY/TOKEN/SECRET/
 * PASSWORD-ish name that also passes the value filters. Used by edges to seed
 * the exact list with what they can see.
 */
export function secretValuesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v || !/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(k)) continue;
    if (v.length >= MIN_EXACT_SECRET && !ENV_REFERENCE.test(v) && !v.includes('/')) out.push(v);
  }
  return out;
}

/** Every string leaf of a JSON document that looks like a credential (token files). */
export function secretValuesFromJson(text: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string): void => {
    if (typeof v === 'string') {
      if (/(token|secret|key|password)/i.test(key) && v.length >= MIN_EXACT_SECRET) out.push(v);
      return;
    }
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
    }
  };
  try {
    walk(JSON.parse(text), '');
  } catch {
    /* not JSON: nothing to learn */
  }
  return out;
}
