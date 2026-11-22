/**
 * PC-side secret scan, run before a skill leaves this machine.
 *
 * A small set of gitleaks-class content rules plus the three suppressions
 * Phase 0 showed are needed (docs/hub-skills-plan.md, "Secret scan"): over this
 * owner's real skills and plugins, 299 raw hits were ALL documentation
 * placeholders (`Bearer YOUR_API_KEY`, `<YOUR_..._PRIVATE_KEY>`), 40-hex git
 * SHAs, or test fixtures. Without suppressing those, every seed would skip the
 * skills it exists to carry.
 *
 * A finding names the rule, file and line — never the matched value, so the scan
 * itself can't print a secret.
 */

export interface SecretFinding {
  rule: string;
  path: string;
  line: number;
}

interface Rule {
  id: string;
  re: RegExp;
  /** Minimum Shannon entropy (bits/char) of the captured value, when set. */
  minEntropy?: number;
}

const RULES: Rule[] = [
  {
    id: 'private-key',
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----\r?\n([A-Za-z0-9+/=\r\n]{64,})/g,
  },
  { id: 'aws-access-key', re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g },
  {
    id: 'github-token',
    re: /\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  { id: 'slack-token', re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { id: 'llm-api-key', re: /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,})\b/g, minEntropy: 3.5 },
  { id: 'google-api-key', re: /\b(AIza[0-9A-Za-z_-]{35})\b/g },
  { id: 'stripe-live-key', re: /\b((?:sk|rk)_live_[0-9a-zA-Z]{24,})\b/g },
  {
    id: 'bearer-token',
    re: /Authorization:\s*Bearer\s+([A-Za-z0-9._~+/=-]{20,})/gi,
    minEntropy: 3.5,
  },
  {
    id: 'generic-secret',
    re: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)["']?\s*[:=]\s*["']([A-Za-z0-9_\-/+=.]{20,})["']/gi,
    minEntropy: 3.5,
  },
  // The `.env` / YAML shape: an unquoted value on a line whose key names a
  // secret (`API_KEY=…`, `export FAL_KEY=…`, `token: …`). Anchored at line start
  // so prose and command lines (`--api-key=$KEY`) don't match.
  {
    id: 'env-assignment',
    re: /^[ \t]*(?:export[ \t]+)?[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSW(?:OR)?D|PWD)[A-Za-z0-9_.-]*[ \t]*[:=][ \t]*([^\s'"#]{16,})/gim,
    minEntropy: 3.5,
  },
  // Credentials inside a URL: `postgres://admin:S3cr3t@db:5432/app`.
  {
    id: 'url-credentials',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:([^@\s/'"]{6,})@/gi,
  },
];

/**
 * Files whose NAME says they hold credentials, whatever their content: a
 * finding by name, so a skill carrying one is skipped by the seed and needs a
 * confirm in the TUI. Template files (`.env.example`, `.env.sample`, …) are the
 * documented way to ship the shape without the values, so they don't count.
 */
const SECRET_FILE_RE =
  /^(?:\.env(?:\..+)?|.+\.pem|.+\.key|id_(?:rsa|dsa|ecdsa|ed25519)(?:_[^.]+)?|\.netrc|\.npmrc|\.pypirc|credentials[^/]*\.json)$/i;
const SECRET_FILE_TEMPLATE_RE = /\.(?:example|sample|template|dist|tmpl)$/i;

export function isSecretFileName(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return SECRET_FILE_RE.test(base) && !SECRET_FILE_TEMPLATE_RE.test(base);
}

// Suppression 1: documentation placeholders.
const PLACEHOLDER_RE =
  /YOUR[_-]|<[^>]*>|x{4,}|example|changeme|replace|dummy|placeholder|redacted|sample|\.\.\.|\*{3,}/i;
// A value that refers to a secret rather than being one: a variable reference
// (`$FAL_KEY`, `${TOKEN}`, `$(cat …)`) or a filesystem path (`~/.ssh/key`).
const INDIRECT_VALUE_RE = /^(?:\$|~|\.{0,2}\/)|\$\{|process\.env|os\.environ/;
// Source code assigning an expression, not a literal: a call, index or
// collection (`get_api_key(args)`, `Collection[str],`), or a bare identifier
// (`s.subagentTokens`, `SWITCH_CAPTIONS_EVERY_MS`). A credential value has
// neither code punctuation nor the digit-free shape of a name. Measured on this
// owner's skills and plugins: every env-assignment hit before this filter was one
// of these.
const CODE_VALUE_RE = /[()[\]{},;]|^[A-Za-z_][A-Za-z_.]*$/;
// URL passwords documentation uses verbatim.
const URL_PLACEHOLDER_PASSWORD_RE = /^(?:pass(?:word)?|pwd|secret|changeme|\*+|\$\{?\w+\}?|:\w+)$/i;
// Suppression 2: git object ids (sha1 / sha256 hex).
const HEX_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
// Suppression 3: test fixtures.
const FIXTURE_PATH_RE =
  /(^|\/)(tests?|__tests__|fixtures?|__fixtures__|spec|testdata)(\/|$)|\.(test|spec)\.[A-Za-z0-9]+$/i;

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8192).includes(0);
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function scanSkillFiles(files: readonly { path: string; data: Buffer }[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const f of files) {
    // By name first, ahead of the fixture and binary skips: a file called `.env`
    // or `id_ed25519` is a credential wherever it sits, and a `.key` may be DER.
    if (isSecretFileName(f.path)) findings.push({ rule: 'secret-file', path: f.path, line: 1 });
    if (FIXTURE_PATH_RE.test(f.path) || isBinary(f.data)) continue;
    const text = f.data.toString('utf8');
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of text.matchAll(rule.re)) {
        const value = m[1] ?? m[0];
        // The private-key body is base64 by construction; judge the line after
        // the BEGIN marker, where a placeholder (`<YOUR_..._KEY>`) would sit.
        const judged = rule.id === 'private-key' ? (value.split(/\r?\n/)[0] ?? '') : value;
        if (PLACEHOLDER_RE.test(judged) || HEX_SHA_RE.test(judged)) continue;
        if (
          rule.id === 'env-assignment' &&
          (INDIRECT_VALUE_RE.test(judged) || CODE_VALUE_RE.test(judged))
        ) {
          continue;
        }
        if (rule.id === 'url-credentials' && URL_PLACEHOLDER_PASSWORD_RE.test(judged)) continue;
        if (rule.minEntropy !== undefined && shannonEntropy(judged) < rule.minEntropy) continue;
        findings.push({ rule: rule.id, path: f.path, line: lineOf(text, m.index ?? 0) });
      }
    }
  }
  return findings;
}
