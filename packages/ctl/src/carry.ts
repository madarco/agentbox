import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

/**
 * One entry from the host-side `carry:` block in `agentbox.yaml`.
 *
 * Paths are kept user-facing (still containing `~/` or `./`) — resolution to
 * absolute paths, project-root anchoring, and safety checks happen in the
 * apps/cli resolver, not here. This package is shipped inside the box and
 * must stay free of host-only assumptions.
 */
export interface CarryItem {
  src: string;
  dest: string;
  mode?: number;
  /**
   * Numeric uid that should own the carried file inside the box. When unset,
   * the copy step defaults to 1000 (the `vscode` user every box runs as) so
   * the carried files are always agent-readable. Set 0 to keep root-owned.
   */
  user?: number;
  /**
   * Extra paths to drop when carrying a directory (tar glob like `*​/cache` or a
   * bare dir name). Additive on top of the host CLI's default heavy-dir excludes
   * (`.git`, `node_modules`, ...). Ignored for file entries.
   */
  exclude?: string[];
  optional: boolean;
}

export class CarryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CarryConfigError';
  }
}

const ITEM_KEYS = new Set(['src', 'dest', 'mode', 'user', 'exclude', 'optional']);

function parseExclude(raw: unknown, where: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new CarryConfigError(`${where}.exclude must be a list of glob/name strings`);
  }
  const out: string[] = [];
  for (const [i, v] of raw.entries()) {
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new CarryConfigError(`${where}.exclude[${String(i)}] must be a non-empty string`);
    }
    out.push(v.trim());
  }
  return out.length > 0 ? out : undefined;
}

function parseUser(raw: unknown, where: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  let n: number;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new CarryConfigError(`${where}.user must be a non-negative integer uid (got ${String(raw)})`);
    }
    n = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      throw new CarryConfigError(
        `${where}.user "${raw}" must be a numeric uid (e.g. 1000). Usernames not supported — look up the uid first.`,
      );
    }
    n = parseInt(trimmed, 10);
  } else {
    throw new CarryConfigError(`${where}.user must be a non-negative integer uid`);
  }
  if (n > 65535) {
    throw new CarryConfigError(`${where}.user must be between 0 and 65535 (got ${String(n)})`);
  }
  return n;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertSrcShape(src: string, where: string): void {
  if (src.length === 0) {
    throw new CarryConfigError(`${where}.src must not be empty`);
  }
  if (!src.startsWith('/') && !src.startsWith('~/') && !src.startsWith('./')) {
    throw new CarryConfigError(
      `${where}.src "${src}" must start with /, ~/, or ./ (bare relative paths are rejected to avoid surprises)`,
    );
  }
}

function assertDestShape(dest: string, where: string): void {
  if (dest.length === 0) {
    throw new CarryConfigError(`${where}.dest must not be empty`);
  }
  if (!dest.startsWith('/') && !dest.startsWith('~/')) {
    throw new CarryConfigError(
      `${where}.dest "${dest}" must start with / or ~/ (relative box-side paths are not allowed)`,
    );
  }
}

function parseMode(raw: unknown, where: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  let n: number;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new CarryConfigError(`${where}.mode must be a non-negative integer (got ${String(raw)})`);
    }
    n = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new CarryConfigError(`${where}.mode must not be empty`);
    }
    // Accept "0600", "600", "0o600". Always interpreted as octal.
    const cleaned = trimmed.startsWith('0o') || trimmed.startsWith('0O') ? trimmed.slice(2) : trimmed;
    if (!/^[0-7]+$/.test(cleaned)) {
      throw new CarryConfigError(
        `${where}.mode "${raw}" must be an octal number (e.g. 0o600, "0600", "600")`,
      );
    }
    n = parseInt(cleaned, 8);
  } else {
    throw new CarryConfigError(`${where}.mode must be a number or octal string`);
  }
  if (n < 0 || n > 0o7777) {
    throw new CarryConfigError(`${where}.mode must be between 0 and 0o7777 (got ${n.toString(8)})`);
  }
  return n;
}

function parseShorthand(raw: string, where: string): CarryItem {
  // Split on first '=', so values containing '=' survive in dest.
  const eq = raw.indexOf('=');
  let src: string;
  let dest: string;
  if (eq === -1) {
    src = raw;
    dest = raw;
  } else {
    src = raw.slice(0, eq);
    dest = raw.slice(eq + 1);
  }
  src = src.trim();
  dest = dest.trim();
  assertSrcShape(src, where);
  if (eq === -1) {
    // Shorthand without explicit dest: src must be absolute or ~/ so dest
    // can mirror it. `./relative` shorthand has no meaningful in-box dest.
    if (src.startsWith('./')) {
      throw new CarryConfigError(
        `${where} shorthand "${raw}" must specify an explicit dest (use "src=dest") when src starts with ./`,
      );
    }
  }
  assertDestShape(dest, where);
  return { src, dest, optional: false };
}

function parseMapping(raw: Record<string, unknown>, where: string): CarryItem {
  for (const key of Object.keys(raw)) {
    if (!ITEM_KEYS.has(key)) {
      throw new CarryConfigError(`${where} has unknown key "${key}"`);
    }
  }
  const srcRaw = raw.src;
  if (typeof srcRaw !== 'string') {
    throw new CarryConfigError(`${where}.src must be a string`);
  }
  const src = srcRaw.trim();
  assertSrcShape(src, where);

  let dest: string;
  if (raw.dest === undefined || raw.dest === null) {
    if (src.startsWith('./')) {
      throw new CarryConfigError(
        `${where}.dest is required when src starts with ./ (no sensible in-box default)`,
      );
    }
    dest = src;
  } else {
    if (typeof raw.dest !== 'string') {
      throw new CarryConfigError(`${where}.dest must be a string`);
    }
    dest = raw.dest.trim();
  }
  assertDestShape(dest, where);

  const mode = parseMode(raw.mode, where);
  const user = parseUser(raw.user, where);
  const exclude = parseExclude(raw.exclude, where);

  let optional = false;
  if (raw.optional !== undefined && raw.optional !== null) {
    if (typeof raw.optional !== 'boolean') {
      throw new CarryConfigError(`${where}.optional must be a boolean`);
    }
    optional = raw.optional;
  }

  const out: CarryItem = { src, dest, optional };
  if (mode !== undefined) out.mode = mode;
  if (user !== undefined) out.user = user;
  if (exclude !== undefined) out.exclude = exclude;
  return out;
}

export function parseCarryRaw(raw: unknown): CarryItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new CarryConfigError('carry must be a list of strings or mappings');
  }
  const out: CarryItem[] = [];
  for (const [i, item] of raw.entries()) {
    const where = `carry[${String(i)}]`;
    if (typeof item === 'string') {
      out.push(parseShorthand(item, where));
    } else if (isPlainObject(item)) {
      out.push(parseMapping(item, where));
    } else {
      throw new CarryConfigError(`${where} must be a string or mapping`);
    }
  }
  return out;
}

export function parseCarrySection(text: string): CarryItem[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new CarryConfigError(
      `yaml parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (doc === null || doc === undefined) return [];
  if (!isPlainObject(doc)) {
    throw new CarryConfigError('top-level config must be a mapping');
  }
  return parseCarryRaw(doc.carry);
}

export async function loadCarrySection(path: string): Promise<CarryItem[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return parseCarrySection(text);
}
