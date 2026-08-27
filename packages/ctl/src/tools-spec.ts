import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

/**
 * The host-side `tools:` block in `agentbox.yaml` — a project's *request*
 * for host CLIs its agents need.
 *
 * A request is not a grant. `agentbox.yaml` is committed, so a cloned repo
 * declaring `tools: [aws]` must not be able to reach the host's AWS
 * credentials on its own. The host CLI prompts once at create time (the same
 * shape as the `carry:` gate) and writes the approved entries to the
 * host-only grant file; the relay reads only that. See docs/host-tools.md.
 *
 * Parsed here (rather than host-side) for the same reason `carry` is: the
 * supervisor must be able to parse a yaml that declares the block without
 * tripping the unknown-top-level-key check, and `ctl validate` should fail
 * loud on a typo while the user is still in the box.
 */
export interface ToolRequest {
  /** Command name the agent types in the box; also the shim symlink name. */
  name: string;
  /** Host binary to execute. Defaults to `name`. */
  bin?: string;
  /** Argv patterns (regex) that run without a host prompt. */
  allow?: string[];
  /** Argv patterns (regex) refused outright, on top of the built-in deny list. */
  deny?: string[];
  /** Per-call wall-clock budget in ms. */
  timeoutMs?: number;
}

export class ToolsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolsConfigError';
  }
}

const ITEM_KEYS = new Set(['bin', 'allow', 'deny', 'timeoutMs']);

/**
 * Same shape rule as the grant store's `isValidToolName`: the name becomes a
 * `~/.local/bin/<name>` symlink, so it must be a plain command name.
 * Duplicated rather than imported because `@agentbox/ctl` ships inside the
 * box and does not depend on `@agentbox/config`.
 */
const TOOL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;

export function parseToolsRaw(raw: unknown): ToolRequest[] {
  if (raw === undefined || raw === null) return [];
  // Two accepted spellings: a bare list of names (`tools: [terraform, aws]`)
  // and a mapping of name -> options. The list form covers the common case
  // where the project just needs the binary with default gating.
  if (Array.isArray(raw)) {
    return raw.map((item, i) => {
      if (typeof item !== 'string') {
        throw new ToolsConfigError(
          `tools[${String(i)}] must be a tool name string (use the mapping form for options)`,
        );
      }
      return { name: assertName(item.trim(), `tools[${String(i)}]`) };
    });
  }
  if (!isPlainObject(raw)) {
    throw new ToolsConfigError('tools must be a list of names or a mapping of name -> options');
  }
  const out: ToolRequest[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const where = `tools.${name}`;
    assertName(name, where);
    if (value === null || value === undefined) {
      out.push({ name });
      continue;
    }
    if (!isPlainObject(value)) {
      throw new ToolsConfigError(`${where} must be a mapping of options (or empty)`);
    }
    for (const key of Object.keys(value)) {
      if (!ITEM_KEYS.has(key)) {
        throw new ToolsConfigError(
          `${where}.${key} is not a known option (allowed: ${[...ITEM_KEYS].join(', ')})`,
        );
      }
    }
    const req: ToolRequest = { name };
    if (value['bin'] !== undefined) {
      if (typeof value['bin'] !== 'string' || value['bin'].trim().length === 0) {
        throw new ToolsConfigError(`${where}.bin must be a non-empty string`);
      }
      const bin = value['bin'].trim();
      // Must be a bare command name resolved on the host's PATH — never a
      // path. A committed yaml that could say `bin: ./scripts/thing` would
      // get a script from its own checkout executed on the host with the
      // host's credentials, which is exactly what the request-vs-grant split
      // exists to prevent. (`agentbox tools add --bin` is unrestricted: that
      // is the user typing on their own machine.)
      if (!TOOL_NAME_RE.test(bin)) {
        throw new ToolsConfigError(
          `${where}.bin "${bin}" must be a bare command name resolved on PATH, not a path`,
        );
      }
      req.bin = bin;
    }
    const allow = parsePatternList(value['allow'], `${where}.allow`);
    if (allow) req.allow = allow;
    const deny = parsePatternList(value['deny'], `${where}.deny`);
    if (deny) req.deny = deny;
    if (value['timeoutMs'] !== undefined) {
      const n = value['timeoutMs'];
      if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
        throw new ToolsConfigError(`${where}.timeoutMs must be a positive integer (milliseconds)`);
      }
      req.timeoutMs = n;
    }
    out.push(req);
  }
  return out;
}

export function parseToolsSection(text: string): ToolRequest[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ToolsConfigError(
      `yaml parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (doc === null || doc === undefined) return [];
  if (!isPlainObject(doc)) {
    throw new ToolsConfigError('top-level config must be a mapping');
  }
  return parseToolsRaw(doc['tools']);
}

export async function loadToolsSection(path: string): Promise<ToolRequest[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return parseToolsSection(text);
}

// Patterns are compiled here so a typo in agentbox.yaml fails at parse time
// rather than silently never matching (an unmatched `deny` would be a hole).
function parsePatternList(raw: unknown, where: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ToolsConfigError(`${where} must be a list of regex patterns`);
  }
  const out: string[] = [];
  for (const [i, v] of raw.entries()) {
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new ToolsConfigError(`${where}[${String(i)}] must be a non-empty string`);
    }
    const pattern = v.trim();
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new ToolsConfigError(
        `${where}[${String(i)}] is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    out.push(pattern);
  }
  return out.length > 0 ? out : undefined;
}

function assertName(name: string, where: string): string {
  if (!TOOL_NAME_RE.test(name)) {
    throw new ToolsConfigError(
      `${where}: "${name}" is not a valid tool name (plain command name, no path separators)`,
    );
  }
  return name;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
