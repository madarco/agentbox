/**
 * Provider-neutral text-replacement engine. Pure (no fs / no yaml) so it can be
 * shared by the host carry path (`renderCarryEntries`) and the in-box
 * `agentbox-ctl render` CLI without a dependency cycle. The yaml/fs loaders that
 * read a `replacements:` block live in `@agentbox/ctl` (which has those deps).
 */

/**
 * The fixed set of `{{NAME}}` placeholders that `replaceEnvs` / `--env`
 * substitution recognizes. Deliberately a whitelist (not "any env var") so a
 * rendered file is predictable: a stray `{{FOO}}` is left untouched rather than
 * silently clobbered, and secrets/tokens are never substitutable.
 */
export const PLACEHOLDER_KEYS = [
  'AGENTBOX_BOX_NAME',
  'AGENTBOX_BOX_ID',
  'AGENTBOX_BOX_KIND',
  'AGENTBOX_HOST_WORKSPACE',
  'AGENTBOX_PROJECT_ROOT',
  // Convenience: the portless host this box publishes (`<box-name>.localhost`).
  // Derived from AGENTBOX_BOX_NAME when not set explicitly.
  'AGENTBOX_BOX_HOST',
] as const;

export type PlaceholderKey = (typeof PLACEHOLDER_KEYS)[number];

const PLACEHOLDER_SET = new Set<string>(PLACEHOLDER_KEYS);

/** A single regex/literal substitution. `to` may itself contain placeholders. */
export interface ReplaceRule {
  from: string;
  to: string;
  /** Treat `from` as a JS regex (with `flags`); otherwise a literal string. */
  regex?: boolean;
  /** Regex flags (default `g`). Ignored unless `regex` is true. */
  flags?: string;
}

export class ReplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplaceError';
  }
}

const PLACEHOLDER_RE = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

/**
 * Replace `{{NAME}}` placeholders whose NAME is in {@link PLACEHOLDER_KEYS}
 * with the matching value from `context`. Unknown names (not whitelisted) are
 * left as-is. Whitelisted names with no value in `context` are also left as-is
 * (and reported via `onWarn`).
 */
export function substitutePlaceholders(
  text: string,
  context: Record<string, string>,
  onWarn?: (msg: string) => void,
): string {
  return text.replace(PLACEHOLDER_RE, (match, name: string) => {
    if (!PLACEHOLDER_SET.has(name)) return match;
    const value = context[name];
    if (value === undefined) {
      onWarn?.(`placeholder {{${name}}} has no value in this context — left untouched`);
      return match;
    }
    return value;
  });
}

export interface ApplyReplacementsOptions {
  /** When true, substitute `{{NAME}}` whitelist placeholders across the file. */
  env?: boolean;
  /** Ordered custom rules applied after (or instead of) placeholder env subst. */
  rules?: ReplaceRule[];
  /** Placeholder values (used by both `env` subst and rule `to` strings). */
  context: Record<string, string>;
  onWarn?: (msg: string) => void;
}

/**
 * Apply env-placeholder substitution and/or custom rules to file content.
 * Rules run in declaration order; each rule's `to` string is itself run through
 * placeholder substitution so `to: '.{{AGENTBOX_BOX_NAME}}.localhost'` works
 * regardless of `env`.
 */
export function applyReplacements(content: string, opts: ApplyReplacementsOptions): string {
  let out = content;
  if (opts.env) {
    out = substitutePlaceholders(out, opts.context, opts.onWarn);
  }
  for (const rule of opts.rules ?? []) {
    const to = substitutePlaceholders(rule.to, opts.context, opts.onWarn);
    if (rule.regex) {
      let re: RegExp;
      try {
        re = new RegExp(rule.from, rule.flags ?? 'g');
      } catch (err) {
        throw new ReplaceError(
          `invalid regex "${rule.from}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      out = out.replace(re, to);
    } else {
      // Literal: split/join so `$`/special chars in either side stay literal.
      out = out.split(rule.from).join(to);
    }
  }
  return out;
}

/** Build the whitelist placeholder context from a process environment. */
export function placeholderContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const ctx: Record<string, string> = {};
  for (const key of PLACEHOLDER_KEYS) {
    const v = env[key];
    if (typeof v === 'string' && v.length > 0) ctx[key] = v;
  }
  if (ctx.AGENTBOX_BOX_HOST === undefined && ctx.AGENTBOX_BOX_NAME !== undefined) {
    ctx.AGENTBOX_BOX_HOST = `${ctx.AGENTBOX_BOX_NAME}.localhost`;
  }
  return ctx;
}

// --- rule parsing (shared by config top-level `replacements:` and the CLI) ---

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const RULE_KEYS = new Set(['from', 'to', 'regex', 'flags']);

/** Parse one rule mapping (from `replacements:` blocks or carry `replace:`). */
export function parseReplaceRule(raw: unknown, where: string): ReplaceRule {
  if (!isPlainObject(raw)) {
    throw new ReplaceError(`${where} must be a mapping with at least { from, to }`);
  }
  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.has(key)) throw new ReplaceError(`${where} has unknown key "${key}"`);
  }
  if (typeof raw.from !== 'string' || raw.from.length === 0) {
    throw new ReplaceError(`${where}.from must be a non-empty string`);
  }
  if (typeof raw.to !== 'string') {
    throw new ReplaceError(`${where}.to must be a string`);
  }
  const rule: ReplaceRule = { from: raw.from, to: raw.to };
  if (raw.regex !== undefined && raw.regex !== null) {
    if (typeof raw.regex !== 'boolean') throw new ReplaceError(`${where}.regex must be a boolean`);
    rule.regex = raw.regex;
  }
  if (raw.flags !== undefined && raw.flags !== null) {
    if (typeof raw.flags !== 'string') throw new ReplaceError(`${where}.flags must be a string`);
    rule.flags = raw.flags;
  }
  if (rule.regex) {
    try {
      new RegExp(rule.from, rule.flags ?? 'g');
    } catch (err) {
      throw new ReplaceError(
        `${where}.from is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return rule;
}

/** Parse a list of rules (carry `replace:` or a `replacements:` named set). */
export function parseReplaceRules(raw: unknown, where: string): ReplaceRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ReplaceError(`${where} must be a list of rules`);
  return raw.map((r, i) => parseReplaceRule(r, `${where}[${String(i)}]`));
}

/** Parse the top-level `replacements:` block: name → rule list. */
export function parseReplacements(raw: unknown): Record<string, ReplaceRule[]> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    throw new ReplaceError('replacements must be a mapping of name → rule list');
  }
  const out: Record<string, ReplaceRule[]> = {};
  for (const [name, rules] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new ReplaceError(`replacements.${name}: name must match [A-Za-z0-9_-]+`);
    }
    out[name] = parseReplaceRules(rules, `replacements.${name}`);
  }
  return out;
}

/**
 * Resolve a list of named rule-set references against a `replacements:` map,
 * concatenating their rules in reference order. Throws on an unknown name.
 */
export function resolveRuleRefs(
  refs: string[],
  replacements: Record<string, ReplaceRule[]>,
  where: string,
): ReplaceRule[] {
  const out: ReplaceRule[] = [];
  for (const name of refs) {
    const set = replacements[name];
    if (set === undefined) {
      const known = Object.keys(replacements);
      throw new ReplaceError(
        `${where}: unknown replacements rule-set "${name}"` +
          (known.length > 0 ? ` (known: ${known.join(', ')})` : ' (none declared)'),
      );
    }
    out.push(...set);
  }
  return out;
}

/** Parse a CLI `--rule 'from=>to'` argument into a rule. `regex` opt-in. */
export function parseRuleArg(arg: string, regex: boolean): ReplaceRule {
  const idx = arg.indexOf('=>');
  if (idx === -1) {
    throw new ReplaceError(`--rule "${arg}" must be of the form 'from=>to'`);
  }
  const from = arg.slice(0, idx);
  const to = arg.slice(idx + 2);
  if (from.length === 0) throw new ReplaceError(`--rule "${arg}" has an empty 'from'`);
  return parseReplaceRule({ from, to, ...(regex ? { regex: true } : {}) }, `--rule "${arg}"`);
}
