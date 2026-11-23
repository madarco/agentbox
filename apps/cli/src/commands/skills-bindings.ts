/**
 * `agentbox skills enable|disable <names…> [--project [url]] [--workspace [ref]]`
 * and `agentbox skills bindings`: the hub's skill bindings
 * (docs/hub-skills-plan.md, Phase 4).
 *
 * A binding includes or excludes a library skill for every box of a scope; the
 * most specific scope wins (box > project > workspace > global), and a skill
 * bound nowhere is in every box. A project is keyed by its repo, computed here
 * with this PC's `~/.ssh/config` aliases expanded (the same key the box's
 * registration carries), so the binding applies to that repo's boxes from any
 * PC on the hub.
 */
import { Command } from 'commander';
import { execa } from 'execa';
import { repoKeyAtEdge } from '@agentbox/sandbox-core';
import { withHubClient } from '../control-plane/with-hub.js';
import { pickWorkspace, workspaceHub } from '../lib/workspace-ref.js';
import { gitToplevel } from '../lib/memory-local.js';
import { SKILL_NAME_RE } from '../lib/skills/selection.js';
import type {
  HubApiClient,
  HubApiSkillBindingMode,
  HubApiSkillBindingTarget,
  HubApiSkillBindingsDoc,
} from '../control-plane/hub-api-client.js';

interface BindOpts {
  project?: string | true;
  workspace?: string | true;
  clear?: boolean;
}

async function originOf(cwd: string): Promise<string | undefined> {
  const top = await gitToplevel(cwd);
  if (!top) return undefined;
  const r = await execa('git', ['-C', top, 'remote', 'get-url', 'origin'], { reject: false });
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** The scope a command names. Exported for tests via its seams. */
export async function resolveBindingTarget(
  client: Pick<HubApiClient, 'listWorkspaces'>,
  opts: BindOpts,
  deps: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    origin?: (cwd: string) => Promise<string | undefined>;
    keyOf?: (url: string) => Promise<string | undefined>;
  } = {},
): Promise<HubApiSkillBindingTarget> {
  if (opts.project !== undefined && opts.workspace !== undefined) {
    throw new Error('pass --project or --workspace, not both');
  }
  const cwd = deps.cwd ?? process.cwd();
  if (opts.project !== undefined) {
    const url =
      typeof opts.project === 'string' ? opts.project : await (deps.origin ?? originOf)(cwd);
    if (!url) {
      throw new Error(
        'this folder has no git origin remote; pass the repo explicitly: --project <url>',
      );
    }
    const key = await (deps.keyOf ?? ((u: string) => repoKeyAtEdge(u)))(url);
    if (!key || key.startsWith('local:')) {
      throw new Error(`'${url}' is not a remote repo URL a project can be keyed by`);
    }
    return { scope: 'project', scopeId: key };
  }
  if (opts.workspace !== undefined) {
    const ref = typeof opts.workspace === 'string' ? opts.workspace : undefined;
    const env = (deps.env ?? process.env).AGENTBOX_WORKSPACE;
    const ws = pickWorkspace(await client.listWorkspaces(), {
      ...(ref ? { ref } : {}),
      ...(env ? { env } : {}),
      cwd,
    });
    if (!ws) {
      throw new Error(
        ref
          ? `no workspace '${ref}' on the hub (id, folder or a unique name)`
          : 'this folder is not in a workspace; pass --workspace <id|name>',
      );
    }
    return { scope: 'workspace', scopeId: ws.id };
  }
  return { scope: 'global' };
}

function describeTarget(t: HubApiSkillBindingTarget): string {
  return t.scope === 'global' ? 'globally' : `for ${t.scope} ${t.scopeId!}`;
}

function bindAction(mode: HubApiSkillBindingMode) {
  return async (names: string[], opts: BindOpts): Promise<void> => {
    const bad = names.filter((n) => !SKILL_NAME_RE.test(n));
    if (bad.length > 0) {
      process.stderr.write(`invalid skill name(s): ${bad.join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    await withHubClient(workspaceHub(), async (client) => {
      let target: HubApiSkillBindingTarget;
      try {
        target = await resolveBindingTarget(client, opts);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
        return;
      }
      const value = opts.clear ? null : mode;
      const library = new Set((await client.listSkills()).skills.map((s) => s.name));
      await client.putSkillBindings(target, Object.fromEntries(names.map((n) => [n, value])));
      for (const n of names) {
        const note = library.has(n) ? '' : ' (not in the library yet)';
        const verb = opts.clear ? 'binding cleared' : mode === 'include' ? 'enabled' : 'disabled';
        process.stdout.write(`${n}: ${verb} ${describeTarget(target)}${note}\n`);
      }
      // A skill nobody excluded is already in every box, so including it in one
      // workspace or project alone changes nothing. Say how to make it scoped.
      if (!opts.clear && mode === 'include' && target.scope !== 'global') {
        const doc = await client.getSkillBindings();
        const open = names.filter(
          (n) => !(Object.hasOwn(doc.global, n) && doc.global[n] === 'exclude'),
        );
        if (open.length > 0) {
          process.stdout.write(
            `note: ${open.join(', ')} ${open.length === 1 ? 'is' : 'are'} not disabled globally, so every box gets ${open.length === 1 ? 'it' : 'them'} already. ` +
              `To keep ${open.length === 1 ? 'it' : 'them'} to this ${target.scope}: agentbox skills disable ${open.join(' ')}\n`,
          );
        }
      }
    });
  };
}

/** Plain-text listing of every binding, one line per (scope, skill). */
export function renderBindings(
  doc: HubApiSkillBindingsDoc,
  labels: { workspace?: Map<string, string> } = {},
): string {
  const rows: string[][] = [];
  for (const [name, mode] of Object.entries(doc.global)) rows.push(['global', '-', name, mode]);
  for (const scope of ['workspace', 'project', 'box'] as const) {
    for (const [id, map] of Object.entries(doc[scope])) {
      const shown =
        scope === 'workspace' && labels.workspace?.get(id)
          ? `${labels.workspace.get(id)!} (${id})`
          : id;
      for (const [name, mode] of Object.entries(map)) rows.push([scope, shown, name, mode]);
    }
  }
  if (rows.length === 0) return 'No skill bindings: every library skill is in every box.';
  const header = ['SCOPE', 'ID', 'SKILL', 'MODE'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

function scopeOptions(cmd: Command): Command {
  return cmd
    .option('--project [url]', "bind for one repo's boxes (default: this folder's origin)")
    .option(
      '--workspace [ref]',
      "bind for one workspace's boxes (default: the workspace of this folder)",
    )
    .option('--clear', 'remove the binding at that scope (the skill inherits again)');
}

export const skillsEnableCommand = scopeOptions(
  new Command('enable')
    .description('Include library skills in boxes (globally, or for a --project / --workspace)')
    .argument('<names...>', 'skill names'),
).action(bindAction('include'));

export const skillsDisableCommand = scopeOptions(
  new Command('disable')
    .description('Exclude library skills from boxes (globally, or for a --project / --workspace)')
    .argument('<names...>', 'skill names'),
).action(bindAction('exclude'));

export const skillsBindingsCommand = new Command('bindings')
  .description('List the skill bindings on the hub')
  .option('--json', 'print JSON')
  .action(async (opts: { json?: boolean }) => {
    await withHubClient(workspaceHub(), async (client) => {
      const doc = await client.getSkillBindings();
      if (opts.json) {
        process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
        return;
      }
      const names = new Map<string, string>();
      if (Object.keys(doc.workspace).length > 0) {
        for (const w of await client.listWorkspaces().catch(() => [])) names.set(w.id, w.name);
      }
      process.stdout.write(renderBindings(doc, { workspace: names }) + '\n');
    });
  });
