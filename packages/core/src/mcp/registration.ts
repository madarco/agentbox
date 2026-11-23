/**
 * Registering the AgentBox MCP server in an agent's own config file
 * (docs/agent-history-plan.md, Phase 6). Pure text transforms: ctl reads the
 * file, calls {@link applyMcpRegistration}, and writes the result back.
 *
 * The entry is the same command in every box (`agentbox-ctl mcp`, a stdio
 * server that authenticates as the box it runs in), so a config file shared by
 * several docker boxes holds one correct entry for all of them.
 */
import type { AgentMcpSpec } from '../sync/agent-spec.js';

export const AGENTBOX_MCP_SERVER_NAME = 'agentbox';
export const AGENTBOX_MCP_COMMAND = 'agentbox-ctl';
export const AGENTBOX_MCP_ARGS: readonly string[] = ['mcp'];

export type McpRegistrationResult =
  | { ok: true; changed: boolean; text: string }
  | { ok: false; reason: string };

/** The JSON entry for one `entry` kind. */
export function mcpJsonEntry(kind: AgentMcpSpec['entry']): Record<string, unknown> {
  return kind === 'opencode'
    ? { type: 'local', command: [AGENTBOX_MCP_COMMAND, ...AGENTBOX_MCP_ARGS], enabled: true }
    : { type: 'stdio', command: AGENTBOX_MCP_COMMAND, args: [...AGENTBOX_MCP_ARGS] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const TOML_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Add (or correct) the AgentBox server in `text`, the current content of the
 * agent's config file (`null` when it does not exist yet). Leaves everything
 * else as it was. A file that cannot be parsed is reported, never rewritten.
 */
export function applyMcpRegistration(
  text: string | null,
  spec: Pick<AgentMcpSpec, 'format' | 'serversPath' | 'entry'>,
): McpRegistrationResult {
  if (spec.serversPath.length === 0) return { ok: false, reason: 'empty serversPath' };
  if (spec.format === 'toml') return applyToml(text, spec);
  let root: unknown = {};
  if (text !== null && text.trim() !== '') {
    try {
      root = JSON.parse(text);
    } catch (err) {
      return { ok: false, reason: `not valid JSON: ${(err as Error).message}` };
    }
  }
  if (!isRecord(root)) return { ok: false, reason: 'the top level is not an object' };
  let node: Record<string, unknown> = root;
  for (const key of spec.serversPath) {
    const next = node[key];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    } else if (isRecord(next)) {
      node = next;
    } else {
      return { ok: false, reason: `${spec.serversPath.join('.')} is not an object` };
    }
  }
  const want = mcpJsonEntry(spec.entry);
  if (sameJson(node[AGENTBOX_MCP_SERVER_NAME], want)) {
    return { ok: true, changed: false, text: text ?? '' };
  }
  node[AGENTBOX_MCP_SERVER_NAME] = want;
  return { ok: true, changed: true, text: `${JSON.stringify(root, null, 2)}\n` };
}

/**
 * TOML (codex): append a `[<path>.agentbox]` table when the file has none. An
 * existing table of that name is left alone, whoever wrote it: rewriting TOML
 * without a parser would risk the user's own config.
 */
function applyToml(
  text: string | null,
  spec: Pick<AgentMcpSpec, 'serversPath'>,
): McpRegistrationResult {
  if (!spec.serversPath.every((k) => TOML_KEY.test(k))) {
    return { ok: false, reason: 'serversPath has a key that needs quoting' };
  }
  const current = text ?? '';
  if (tomlDefinesServer(current, spec.serversPath)) {
    return { ok: true, changed: false, text: current };
  }
  const block = tomlBlock(spec.serversPath);
  const sep = current === '' ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return { ok: true, changed: true, text: `${current}${sep}${block}` };
}

function tomlBlock(serversPath: readonly string[]): string {
  const table = [...serversPath, AGENTBOX_MCP_SERVER_NAME].join('.');
  const args = AGENTBOX_MCP_ARGS.map((a) => JSON.stringify(a)).join(', ');
  return `[${table}]\ncommand = ${JSON.stringify(AGENTBOX_MCP_COMMAND)}\nargs = [${args}]\n`;
}

/**
 * Whether the TOML already names a server `agentbox` under `serversPath`, in
 * any spelling a parser would merge with ours: a `[a.agentbox]` /
 * `[a."agentbox"]` header (or a sub-table of it), dotted keys
 * `a.agentbox.x = …`, an `agentbox = …` key inside `[a]`, or an inline
 * `a = { agentbox = … }`. Appending next to any of them would be a duplicate
 * key, which makes the whole file unreadable.
 */
function tomlDefinesServer(text: string, serversPath: readonly string[]): boolean {
  const name = `(?:${AGENTBOX_MCP_SERVER_NAME}|"${AGENTBOX_MCP_SERVER_NAME}"|'${AGENTBOX_MCP_SERVER_NAME}')`;
  const path = serversPath.map((k) => `(?:${k}|"${k}"|'${k}')`).join('\\s*\\.\\s*');
  if (new RegExp(`^\\s*\\[\\s*${path}\\s*\\.\\s*${name}\\s*[\\].]`, 'm').test(text)) return true;
  if (new RegExp(`^\\s*${path}\\s*\\.\\s*${name}\\s*[.=]`, 'm').test(text)) return true;
  if (
    new RegExp(`^\\s*${path}\\s*=\\s*\\{[^\\n]*\\b${AGENTBOX_MCP_SERVER_NAME}\\b`, 'm').test(text)
  ) {
    return true;
  }
  // `agentbox = …` as a key of the `[serversPath]` table itself.
  let inTable = false;
  const header = new RegExp(`^\\s*\\[\\s*${path}\\s*\\]\\s*(?:#.*)?$`);
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) inTable = header.test(line);
    else if (inTable && new RegExp(`^\\s*${name}\\s*[.=]`).test(line)) return true;
  }
  return false;
}

/**
 * Take the AgentBox server back out of `text`, but only the exact entry ctl
 * writes: a box config pulled to the host must not carry a server whose
 * command exists only in boxes. Anything else is left as it was.
 */
export function removeMcpRegistration(
  text: string,
  spec: Pick<AgentMcpSpec, 'format' | 'serversPath' | 'entry'>,
): { changed: boolean; text: string } {
  if (spec.format === 'toml') {
    const block = tomlBlock(spec.serversPath);
    if (!text.includes(block)) return { changed: false, text };
    const out = text.replace(`\n\n${block}`, '\n').replace(`\n${block}`, '\n').replace(block, '');
    return { changed: true, text: out };
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { changed: false, text };
  }
  let node: unknown = root;
  for (const key of spec.serversPath) node = isRecord(node) ? node[key] : undefined;
  if (!isRecord(node) || !sameJson(node[AGENTBOX_MCP_SERVER_NAME], mcpJsonEntry(spec.entry))) {
    return { changed: false, text };
  }
  delete node[AGENTBOX_MCP_SERVER_NAME];
  return { changed: true, text: `${JSON.stringify(root, null, 2)}\n` };
}

/**
 * Narrow an `agents.list` descriptor's `mcp` field (untrusted wire input).
 * Absolute or `~/` paths only, never one with a `..` segment.
 */
export function parseAgentMcpSpec(raw: unknown): AgentMcpSpec | null {
  if (!isRecord(raw)) return null;
  const { file, format, serversPath, entry } = raw;
  if (typeof file !== 'string' || !(file.startsWith('/') || file.startsWith('~/'))) return null;
  if (file.split('/').includes('..')) return null;
  if (format !== 'json' && format !== 'toml') return null;
  if (entry !== 'stdio' && entry !== 'opencode') return null;
  if (
    !Array.isArray(serversPath) ||
    serversPath.length === 0 ||
    !serversPath.every((k) => typeof k === 'string' && k.length > 0)
  ) {
    return null;
  }
  return { file, format, serversPath: serversPath as string[], entry };
}
