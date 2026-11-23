// The skills tool set of the hub's MCP server (docs/hub-skills-plan.md,
// Phase 7): an agent can list and read the library skills its box may see, and
// ask for one its create flags left out. A box sees only what its bindings
// resolve to (box > project > workspace > global); a hub caller sees the whole
// library. The only write, an install, waits for a human approval.
import {
  hasWorkspaceBindings,
  readBindings,
  resolveBindings,
  resolveSkillDecisions,
  type SkillBindingContext,
} from '@agentbox/core';
import { readTar } from '@agentbox/sandbox-core';
import { McpToolError, type McpScope, type McpTool } from './mcp';
import { putSkillBindings } from './skill-bindings';
import { readSkillMeta, SEEDED_MARKER, SKILLS_SCOPE, type SkillsStore } from './skills';

export interface SkillsMcpDeps {
  store: () => SkillsStore | undefined;
  log?: (line: string) => void;
}

/** Characters of one file a `skill_get` reply carries before it pages. */
const PAGE_CHARS = 48_000;
const SKILL_FILE = 'SKILL.md';
/** Custody's default blob cap: a stored skill never legitimately unpacks past it. */
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

function storeOf(deps: SkillsMcpDeps): SkillsStore {
  const s = deps.store();
  if (!s) throw new McpToolError('the skills library is not enabled on this hub');
  return s;
}

interface View {
  /** False when the library was never seeded. */
  library: boolean;
  /** Skills this caller may see, sorted. */
  visible: string[];
  /** For a box: the subset its full resolution (bindings + create flags) installs. */
  installed?: Set<string>;
}

async function libraryNames(store: SkillsStore): Promise<{ seeded: boolean; names: string[] }> {
  const entries = await store.list(SKILLS_SCOPE);
  const names = new Set<string>();
  for (const e of entries) {
    const m = /^skills\/([^/]+)\/meta\.json$/.exec(e.path);
    if (m && NAME_RE.test(m[1]!)) names.add(m[1]!);
  }
  return { seeded: entries.some((e) => e.path === SEEDED_MARKER), names: [...names].sort() };
}

/** What `scope` may see of the library, resolved the way `skills.get` resolves a box. */
export async function skillsView(store: SkillsStore, scope: McpScope): Promise<View> {
  const { seeded, names } = await libraryNames(store);
  if (!seeded) return { library: false, visible: [] };
  if (scope.kind === 'hub') return { library: true, visible: names };
  const box = scope.skills;
  // A relay that sent no skill context: the box can't be placed, so it sees nothing.
  if (!box) return { library: true, visible: [], installed: new Set() };
  const doc = await readBindings(store);
  const ctx: SkillBindingContext = {
    boxId: box.boxId,
    ...(box.projectKey ? { projectKey: box.projectKey } : {}),
  };
  if (box.workspaceId && hasWorkspaceBindings(doc)) {
    const ws = await box.workspaceId().catch(() => undefined);
    if (ws) ctx.workspaceId = ws;
  }
  const visible = resolveBindings(names, doc, ctx)
    .filter((r) => r.included)
    .map((r) => r.name);
  const installed = new Set(
    resolveSkillDecisions(names, doc, ctx, box.selection)
      .filter((r) => r.included)
      .map((r) => r.name),
  );
  return { library: true, visible, installed };
}

async function visibleSkill(store: SkillsStore, scope: McpScope, raw: unknown) {
  const name = str(raw);
  if (!name || !NAME_RE.test(name)) throw new McpToolError('name must be a skill name');
  const view = await skillsView(store, scope);
  if (!view.library) throw new McpToolError('this hub has no skills library yet');
  // Not visible and absent read the same, so a box can't probe for names.
  if (!view.visible.includes(name)) throw new McpToolError(`no skill '${name}' is available here`);
  const meta = await readSkillMeta(store, name);
  if (!meta) throw new McpToolError(`no skill '${name}' is available here`);
  return { name, meta, view };
}

function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8192).includes(0);
}

export function skillsMcpTools(deps: SkillsMcpDeps): McpTool[] {
  /** `<boxId>/<name>` of every install request waiting for an answer. */
  const asking = new Set<string>();
  const skillsList: McpTool = {
    name: 'skills_list',
    title: 'List library skills',
    description:
      "List the skills in the AgentBox skills library that this box may use, with `installed` telling whether each is already in this box. Use skill_get to read one; skills_propose_install asks a human to add a missing one to this box. In a box, the list is limited to the skills this box's bindings allow.",
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Filter: words to match in the name or description.' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(args, scope) {
      const store = storeOf(deps);
      const view = await skillsView(store, scope);
      if (!view.library) {
        return { data: { library: false, skills: [], note: 'this hub has no skills library yet' } };
      }
      const words = (str(args.q) ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const skills: Record<string, unknown>[] = [];
      for (const name of view.visible) {
        const meta = await readSkillMeta(store, name);
        if (!meta) continue;
        const hay = `${name} ${meta.description}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
        const cur = meta.versions.find((v) => v.sha256 === meta.current) ?? meta.versions[0];
        skills.push({
          name,
          description: meta.description,
          version: meta.current.slice(0, 12),
          files: cur?.files ?? 0,
          size: cur?.size ?? 0,
          updatedAt: meta.updatedAt,
          ...(view.installed ? { installed: view.installed.has(name) } : {}),
        });
      }
      return { data: { library: true, skills } };
    },
  };

  const skillGet: McpTool = {
    name: 'skill_get',
    title: 'Read a library skill',
    description:
      'Read one library skill: its SKILL.md (or another file of it, by `path`) and its file list. Long files page by `offset` (characters).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, from skills_list.' },
        path: { type: 'string', description: 'File inside the skill (default SKILL.md).' },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(args, scope) {
      const store = storeOf(deps);
      const { name, meta, view } = await visibleSkill(store, scope, args.name);
      const found = await store.get(`${SKILLS_SCOPE}/${name}/${meta.current}.tar.gz`);
      if (!found) throw new McpToolError(`skill '${name}' is missing its stored files`);
      const files = readTar(found.data, { maxBytes: MAX_UNPACKED_BYTES });
      const path = str(args.path) ?? SKILL_FILE;
      const file = files.find((f) => f.path === path);
      if (!file) throw new McpToolError(`skill '${name}' has no file ${path}`);
      const offset =
        typeof args.offset === 'number' && Number.isSafeInteger(args.offset) && args.offset > 0
          ? args.offset
          : 0;
      const base = {
        name,
        description: meta.description,
        version: meta.current.slice(0, 12),
        ...(view.installed ? { installed: view.installed.has(name) } : {}),
        files: files.map((f) => ({ path: f.path, size: f.data.length, mode: f.mode.toString(8) })),
        path,
      };
      if (isBinary(file.data)) {
        return { data: { ...base, content: null, note: 'binary file, not shown' } };
      }
      const text = file.data.toString('utf8');
      const content = text.slice(offset, offset + PAGE_CHARS);
      const next = offset + content.length;
      return {
        data: {
          ...base,
          content,
          ...(next < text.length ? { nextOffset: next, totalChars: text.length } : {}),
        },
      };
    },
  };

  const proposeInstall: McpTool = {
    name: 'skills_propose_install',
    title: 'Ask to install a library skill in this box',
    description:
      "Ask a human to add a library skill to this box (one that skills_list shows with installed: false). The call returns at once with status pending. Once approved, run `agentbox-ctl skills sync`; the skill is active from the agent's next session.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, from skills_list.' },
        reason: { type: 'string', description: 'One line on why, shown to the approver.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, scope) {
      if (scope.kind !== 'box') {
        throw new McpToolError('skills_propose_install is for an agent in a box');
      }
      const store = storeOf(deps);
      const { name, meta, view } = await visibleSkill(store, scope, args.name);
      if (view.installed?.has(name)) {
        return {
          data: {
            status: 'installed',
            name,
            message:
              'Already in this box. If the agent does not list it, run `agentbox-ctl skills sync` and start a new session.',
          },
        };
      }
      const reason = str(args.reason);
      const boxId = scope.boxId;
      const key = `${boxId}/${name}`;
      // A retry waits on the prompt already asked.
      if (asking.has(key)) {
        return { data: { status: 'pending', name, message: 'Already waiting for approval.' } };
      }
      asking.add(key);
      const approved = scope.approve({
        message: `Box ${scope.boxName} asks to install library skill ${name}`,
        detail: `${meta.description.slice(0, 200)}${reason ? ` — ${reason.slice(0, 200)}` : ''}`,
        command: 'skills_propose_install',
      });
      // Not awaited: the agent goes on while a human decides.
      void approved
        .then(async (yes) => {
          if (!yes) return;
          await putSkillBindings(store, { scope: 'box', scopeId: boxId }, { [name]: 'include' });
          deps.log?.(`mcp: skills_propose_install ${name} approved for ${scope.boxName}`);
        })
        .catch((err: unknown) => {
          deps.log?.(
            `mcp: skills_propose_install ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => asking.delete(key));
      return {
        data: {
          status: 'pending',
          name,
          message:
            "Sent for approval. Once approved, run `agentbox-ctl skills sync`; the skill is active from the agent's next session.",
        },
      };
    },
  };

  return [skillsList, skillGet, proposeInstall];
}
