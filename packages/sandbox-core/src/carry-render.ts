import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { applyReplacements, type ResolvedCarryEntry } from '@agentbox/core';

/**
 * Box facts used to fill `{{AGENTBOX_*}}` placeholders in carried files. The
 * placeholder *names* match the in-box `agentbox-ctl render` whitelist; here the
 * values come from the create context (the box is named but not yet booted).
 */
export interface CarryBoxContext {
  name?: string;
  id?: string;
  kind?: string;
  /** Host workspace path (mirrors in-box AGENTBOX_HOST_WORKSPACE). */
  hostWorkspace?: string;
  projectRoot?: string;
}

/** Build the whitelist placeholder context (and derive AGENTBOX_BOX_HOST). */
export function carryPlaceholderContext(ctx: CarryBoxContext): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.name) out.AGENTBOX_BOX_NAME = ctx.name;
  if (ctx.id) out.AGENTBOX_BOX_ID = ctx.id;
  if (ctx.kind) out.AGENTBOX_BOX_KIND = ctx.kind;
  if (ctx.hostWorkspace) out.AGENTBOX_HOST_WORKSPACE = ctx.hostWorkspace;
  if (ctx.projectRoot) out.AGENTBOX_PROJECT_ROOT = ctx.projectRoot;
  if (ctx.name) out.AGENTBOX_BOX_HOST = `${ctx.name}.localhost`;
  return out;
}

/**
 * Render carry entries that opt into `replaceEnvs`/`replace`: read each file
 * host-side, apply the substitutions, write the result to a temp file, and
 * repoint `absSrc` at it so the existing per-provider tar/copy step transfers
 * the rendered content. Entries without replace options pass through unchanged.
 * Returns a new array (inputs are not mutated).
 */
export async function renderCarryEntries(
  entries: ResolvedCarryEntry[],
  ctx: CarryBoxContext,
  onLog?: (line: string) => void,
): Promise<ResolvedCarryEntry[]> {
  const needsRender = entries.some(
    (e) => e.kind === 'file' && (e.replaceEnvs || (e.replace && e.replace.length > 0)),
  );
  if (!needsRender) return entries;

  const context = carryPlaceholderContext(ctx);
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-carry-render-'));
  const out: ResolvedCarryEntry[] = [];
  for (const [i, entry] of entries.entries()) {
    const wants = entry.kind === 'file' && (entry.replaceEnvs || (entry.replace?.length ?? 0) > 0);
    if (!wants) {
      out.push(entry);
      continue;
    }
    const content = await readFile(entry.absSrc, 'utf8');
    const rendered = applyReplacements(content, {
      env: entry.replaceEnvs,
      rules: entry.replace,
      context,
      onWarn: (msg) => onLog?.(`carry: ${entry.rawSrc}: ${msg}`),
    });
    const tmp = join(stage, `${String(i)}-${basename(entry.absSrc)}`);
    await writeFile(tmp, rendered, 'utf8');
    out.push({ ...entry, absSrc: tmp, bytes: Buffer.byteLength(rendered) });
    onLog?.(`carry: rendered ${entry.rawSrc} (${entry.replaceEnvs ? 'env' : ''}${
      entry.replace?.length ? `${entry.replaceEnvs ? '+' : ''}${String(entry.replace.length)} rule(s)` : ''
    })`);
  }
  return out;
}
