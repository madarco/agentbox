import { parse as parseYaml } from 'yaml';
import {
  KEY_REGISTRY,
  type KeyDescriptor,
  type UserConfig,
  UserConfigError,
} from './types.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keys removed in a rename. Surfaced with a migration hint instead of a bare "unknown key". */
const RENAMED_KEYS: ReadonlyMap<string, string> = new Map([['box.snapshot', 'box.hostSnapshot']]);

interface BranchSpec {
  name: string;
  /** Map of leaf-key (dot-suffix) → descriptor whose `key` starts with this branch. */
  leaves: Map<string, KeyDescriptor>;
}

const BRANCHES: Map<string, BranchSpec> = (() => {
  const out = new Map<string, BranchSpec>();
  for (const desc of KEY_REGISTRY) {
    const idx = desc.key.indexOf('.');
    if (idx < 0) {
      throw new Error(`KEY_REGISTRY entry ${desc.key} must use dot-path form (branch.leaf)`);
    }
    const branch = desc.key.slice(0, idx);
    const leaf = desc.key.slice(idx + 1);
    let entry = out.get(branch);
    if (!entry) {
      entry = { name: branch, leaves: new Map() };
      out.set(branch, entry);
    }
    entry.leaves.set(leaf, desc);
  }
  return out;
})();

/**
 * Coerce a typed YAML scalar (already typed by the YAML parser) into the
 * descriptor's expected type. Strings from the CLI go through `coerceFromString`
 * instead — that path accepts e.g. "true" or "120000".
 */
function coerceTypedValue(raw: unknown, desc: KeyDescriptor, where: string): unknown {
  if (raw === null) {
    throw new UserConfigError(`${where} must not be null (use \`agentbox config unset\` to clear)`);
  }
  switch (desc.type) {
    case 'bool':
      if (typeof raw !== 'boolean') {
        throw new UserConfigError(`${where} must be a boolean (got ${typeof raw})`);
      }
      return raw;
    case 'string':
      if (typeof raw !== 'string') {
        throw new UserConfigError(`${where} must be a string (got ${typeof raw})`);
      }
      if (raw.length === 0) {
        throw new UserConfigError(`${where} must not be empty`);
      }
      return raw;
    case 'int':
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        throw new UserConfigError(`${where} must be an integer (got ${String(raw)})`);
      }
      return raw;
    case 'enum':
      if (typeof raw !== 'string' || !desc.enumValues!.includes(raw)) {
        throw new UserConfigError(
          `${where} must be one of: ${desc.enumValues!.join(', ')} (got ${String(raw)})`,
        );
      }
      return raw;
  }
}

/**
 * Parse a UserConfig document text (YAML). Strict: unknown branches and
 * unknown leaves throw UserConfigError so typos surface early.
 *
 * `where` is the human-readable origin for error messages, e.g. the file path.
 * Empty / whitespace-only input parses to `{}`.
 */
export function parseUserConfig(text: string, where: string): Partial<UserConfig> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new UserConfigError(
      `${where}: yaml parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (doc === null || doc === undefined) return {};
  if (!isPlainObject(doc)) {
    throw new UserConfigError(`${where}: top-level must be a mapping`);
  }
  return parseUserConfigObject(doc, where);
}

/**
 * Same validation as `parseUserConfig` but starting from an already-decoded
 * object. Used when the caller has the YAML parsed (e.g. agentbox.yaml's
 * `defaults:` block).
 */
export function parseUserConfigObject(doc: unknown, where: string): Partial<UserConfig> {
  if (doc === null || doc === undefined) return {};
  if (!isPlainObject(doc)) {
    throw new UserConfigError(`${where}: must be a mapping`);
  }

  const out: Partial<UserConfig> = {};
  for (const [branchName, branchRaw] of Object.entries(doc)) {
    // Top-level `schema` is a metadata stamp written by the loader on first
    // save (future-proofs migrations). It's not a config section and never
    // appears in `EffectiveConfig`; carry it through so writers preserve it
    // round-trip, but skip the "must be a mapping" / leaf checks below.
    if (branchName === 'schema') {
      if (branchRaw !== undefined && branchRaw !== null) {
        if (typeof branchRaw !== 'number' || !Number.isInteger(branchRaw)) {
          throw new UserConfigError(`${where}.schema: must be an integer (got ${String(branchRaw)})`);
        }
        out.schema = branchRaw;
      }
      continue;
    }
    const branchSpec = BRANCHES.get(branchName);
    if (!branchSpec) {
      throw new UserConfigError(
        `${where}: unknown config section "${branchName}" (known: ${[...BRANCHES.keys()].join(', ')})`,
      );
    }
    if (branchRaw === null || branchRaw === undefined) continue;
    if (!isPlainObject(branchRaw)) {
      throw new UserConfigError(`${where}.${branchName}: must be a mapping`);
    }
    const branchOut = parseBranchObject(branchSpec, branchName, branchRaw, '', where);
    if (Object.keys(branchOut).length > 0) {
      // We've validated that each branch matches one of UserConfig's known
      // sub-objects; the indexed write keeps the union type happy.
      (out as Record<string, unknown>)[branchName] = branchOut;
    }
  }
  return out;
}

/**
 * Validate a YAML branch sub-tree against `branchSpec`'s registered leaf paths.
 * Handles nested keys like `integrations.notion.enabled` — the branch is
 * `integrations`, the leaf path is `notion.enabled`, so the YAML can be
 * written as a nested mapping. `qualifiedPrefix` is the dotted path walked so
 * far within the branch (empty at top level).
 */
function parseBranchObject(
  branchSpec: BranchSpec,
  branchName: string,
  raw: Record<string, unknown>,
  qualifiedPrefix: string,
  where: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const qualified = qualifiedPrefix ? `${qualifiedPrefix}.${name}` : name;
    const desc = branchSpec.leaves.get(qualified);
    if (desc) {
      out[name] = coerceTypedValue(value, desc, `${where}.${desc.key}`);
      continue;
    }
    // Not a leaf — descend if it's a mapping AND a deeper leaf is registered
    // beneath this path. Otherwise the key is unknown / not in the registry.
    if (isPlainObject(value) && branchHasLeafBelow(branchSpec, qualified)) {
      const sub = parseBranchObject(branchSpec, branchName, value, qualified, where);
      if (Object.keys(sub).length > 0) out[name] = sub;
      continue;
    }
    const renamedTo = RENAMED_KEYS.get(`${branchName}.${qualified}`);
    if (renamedTo) {
      throw new UserConfigError(
        `${where}.${branchName}.${qualified} was renamed to ${renamedTo} — update your config`,
      );
    }
    throw new UserConfigError(
      `${where}.${branchName}: unknown key "${qualified}" (known: ${[...branchSpec.leaves.keys()].join(', ')})`,
    );
  }
  return out;
}

function branchHasLeafBelow(branchSpec: BranchSpec, prefix: string): boolean {
  const needle = `${prefix}.`;
  for (const leaf of branchSpec.leaves.keys()) {
    if (leaf.startsWith(needle)) return true;
  }
  return false;
}

/**
 * Coerce a string (e.g. typed at the CLI by `agentbox config set`) into the
 * declared type for `key`. Booleans accept true/false/yes/no/1/0 (case
 * insensitive). Returns the typed value or throws UserConfigError.
 */
export function coerceFromString(key: string, raw: string): unknown {
  const desc = lookupKeyOrThrow(key);
  switch (desc.type) {
    case 'bool': {
      const v = raw.trim().toLowerCase();
      if (v === 'true' || v === 'yes' || v === '1' || v === 'on') return true;
      if (v === 'false' || v === 'no' || v === '0' || v === 'off') return false;
      throw new UserConfigError(`${key}: expected a boolean (true/false), got "${raw}"`);
    }
    case 'string':
      if (raw.length === 0) throw new UserConfigError(`${key}: must not be empty`);
      return raw;
    case 'int': {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new UserConfigError(`${key}: expected an integer, got "${raw}"`);
      }
      return n;
    }
    case 'enum':
      if (!desc.enumValues!.includes(raw)) {
        throw new UserConfigError(
          `${key}: expected one of ${desc.enumValues!.join(', ')}, got "${raw}"`,
        );
      }
      return raw;
  }
}

function lookupKeyOrThrow(key: string): KeyDescriptor {
  const renamedTo = RENAMED_KEYS.get(key);
  if (renamedTo) {
    throw new UserConfigError(`${key} was renamed to ${renamedTo} — use ${renamedTo} instead`);
  }
  const idx = key.indexOf('.');
  if (idx < 0) {
    throw new UserConfigError(`unknown key "${key}" (must be in branch.leaf form)`);
  }
  const branch = BRANCHES.get(key.slice(0, idx));
  if (!branch) {
    throw new UserConfigError(
      `unknown config section "${key.slice(0, idx)}" (known: ${[...BRANCHES.keys()].join(', ')})`,
    );
  }
  const desc = branch.leaves.get(key.slice(idx + 1));
  if (!desc) {
    throw new UserConfigError(
      `unknown key "${key}" (known in ${branch.name}: ${[...branch.leaves.keys()].join(', ')})`,
    );
  }
  return desc;
}
