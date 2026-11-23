/**
 * `agentbox skills add | import | unlink | refresh | update | diff | policy | ls`:
 * the skills library's sources and updates (docs/hub-skills-plan.md, Phase 5).
 *
 * Every verb is a `/api/v1` call: the hub fetches git and marketplace sources,
 * holds third-party updates as `pending` until `update` approves them, and syncs
 * running boxes itself. `import --link` is the one PC-side piece: it records the
 * folder so this PC's relay re-uploads it on every change.
 */
import { Command, Option } from 'commander';
import { confirm, isCancel, log, multiselect } from '@clack/prompts';
import { loadEffectiveConfig } from '@agentbox/config';
import { homedir } from 'node:os';
import { linkSkill, readLocalSkill, readSkillLinks, unlinkSkills } from '@agentbox/sandbox-core';
import { withHubClient } from '../control-plane/with-hub.js';
import { workspaceHub } from '../lib/workspace-ref.js';
import type {
  HubApiClient,
  HubApiSkill,
  HubApiSkillAddResult,
  HubApiSkillRefresh,
} from '../control-plane/hub-api-client.js';
import { uploadBlocker, uploadLocalSkill } from '../lib/skills/sync.js';
import { renderSkillDiff, resolveMarketplace, skillFoldersAt } from '../lib/skills/sources.js';

function collect(value: string, prev: string[] | undefined): string[] {
  return [
    ...(prev ?? []),
    ...value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}

/** Skill content (diff) is an elevated read: send the admin token when this PC holds it. */
async function adminToken(): Promise<{ adminToken?: string }> {
  const { resolveCustodyTarget } = await import('./control-plane.js');
  const t = await resolveCustodyTarget(undefined, { quiet: true }).catch(() => null);
  return t?.adminToken ? { adminToken: t.adminToken } : {};
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 12) : '-';
}

function fail(msg: string): void {
  log.error(msg);
  process.exitCode = 1;
}

function parsePolicyFlag(v: string | undefined): 'auto' | 'manual' | undefined {
  if (v === undefined) return undefined;
  if (v === 'auto' || v === 'manual') return v;
  throw new Error(`--policy must be auto or manual (got '${v}')`);
}

function originLabel(s: HubApiSkill): string {
  const o = s.origin;
  if (!o || o.kind === 'upload') return 'upload';
  if (o.kind === 'folder') return `linked folder ${o.path}${o.host ? ` on ${o.host}` : ''}`;
  if (o.kind === 'git')
    return `git ${o.url}${o.path ? `#${o.path}` : ''}${o.ref ? `@${o.ref}` : ''}`;
  return `marketplace ${o.marketplace} / ${o.plugin}`;
}

function printAdd(res: HubApiSkillAddResult): void {
  for (const i of res.imported) {
    log.success(
      `${i.name}: ${i.changed ? 'added' : 'unchanged'} (${short(i.version)}, policy ${i.skill.policy ?? 'manual'})`,
    );
  }
  for (const s of res.skipped) log.warn(`${s.name}: skipped — ${s.reason}`);
  if (res.imported.length === 0 && res.skipped.length === 0) log.info('Nothing imported.');
}

// ── add ─────────────────────────────────────────────────────────────────────

interface AddFlags {
  ref?: string;
  path?: string;
  skill?: string[];
  policy?: string;
  marketplace?: string;
  plugin?: string;
  allowFindings?: boolean;
  yes?: boolean;
}

const addCommand = new Command('add')
  .description('Add skills from a git repo (the hub fetches it) or a plugin marketplace')
  .argument('[source]', 'git URL or owner/repo, optionally <url>#<path>@<ref>')
  .option('--ref <ref>', 'branch, tag or commit (default: the remote HEAD)')
  .option('--path <path>', 'folder inside the repo: one skill, or a folder of skills')
  .option('--skill <names>', 'import only these skills (comma-separated, repeatable)', collect)
  .option('--policy <policy>', 'update policy: manual (default for git/marketplace) or auto')
  .option('--marketplace <name>', 'a marketplace name this PC knows, or its git URL / owner/repo')
  .option('--plugin <plugin>', 'with --marketplace: the plugin whose skills to import')
  .option('--allow-findings', 'import skills the secret scan flagged')
  .option('-y, --yes', 'import every skill found without asking')
  .action(async (source: string | undefined, f: AddFlags) => {
    let policy: 'auto' | 'manual' | undefined;
    try {
      policy = parsePolicyFlag(f.policy);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    let body: Parameters<HubApiClient['addSkills']>[0];
    if (f.marketplace) {
      if (!f.plugin) return fail('--marketplace needs --plugin <plugin>');
      const m = await resolveMarketplace(f.marketplace, homedir());
      if (!m) {
        return fail(
          `unknown marketplace '${f.marketplace}': not in ~/.claude/plugins/known_marketplaces.json (pass its git URL or owner/repo)`,
        );
      }
      body = { marketplace: { ...m, plugin: f.plugin } };
    } else {
      if (!source) return fail('give a git URL / owner/repo, or --marketplace <m> --plugin <p>');
      body = {
        git: {
          url: source,
          ...(f.ref ? { ref: f.ref } : {}),
          ...(f.path ? { path: f.path } : {}),
        },
      };
    }
    body = {
      ...body,
      ...(policy ? { policy } : {}),
      ...(f.allowFindings ? { allowFindings: true } : {}),
      ...(f.skill ? { skills: f.skill } : {}),
    };
    await withHubClient(workspaceHub(), async (client) => {
      try {
        if (!f.skill && !f.yes && interactive()) {
          const probe = await client.addSkills({ ...body, dryRun: true });
          if (probe.candidates.length > 1) {
            const chosen = await multiselect({
              message: `The source holds ${String(probe.candidates.length)} skills. Import which?`,
              required: false,
              options: probe.candidates.map((c) => ({
                value: c.name,
                label: c.name,
                hint:
                  c.problems.length > 0
                    ? `invalid: ${c.problems[0] ?? ''}`
                    : c.findings.length > 0
                      ? 'secret-scan findings'
                      : c.description.slice(0, 60),
              })),
            });
            if (isCancel(chosen) || chosen.length === 0) return;
            body = { ...body, skills: chosen };
          }
        }
        printAdd(await client.addSkills(body));
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
  });

// ── import / unlink ─────────────────────────────────────────────────────────

interface ImportFlags {
  link?: boolean;
  linked?: boolean;
  allowFindings?: boolean;
  yes?: boolean;
}

const importCommand = new Command('import')
  .description('Upload skill folders from this PC; --link keeps uploading each one on change')
  .argument('<paths...>', 'a skill folder (with SKILL.md) or a folder of skills')
  .option('--link', "watch the folder: this PC's relay uploads a new version on every change")
  .option('--allow-findings', 'upload skills the secret scan flagged')
  .option('-y, --yes', 'skip confirms')
  // The relay's linked-folder watcher: upload as a linked source, never prompt.
  .addOption(new Option('--linked').hideHelp())
  .action(async (paths: string[], f: ImportFlags) => {
    const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
    const maxBytes = cfg?.effective.skills.maxSkillBytes ?? 50 * 1024 * 1024;
    const folders: { name: string; dir: string }[] = [];
    for (const p of paths) {
      const found = await skillFoldersAt(p);
      if (found.length === 0) return fail(`${p}: no SKILL.md there or in its subfolders`);
      folders.push(...found);
    }
    const quiet = f.linked === true;
    await withHubClient(workspaceHub(), async (client) => {
      for (const { name, dir } of folders) {
        const skill = await readLocalSkill(name, dir, { maxBytes });
        let allowFindings = f.allowFindings === true;
        if (
          !allowFindings &&
          skill.problems.length === 0 &&
          skill.findings.length > 0 &&
          !quiet &&
          interactive() &&
          !f.yes
        ) {
          const where = skill.findings
            .map((x) => `${x.rule} in ${x.path}:${String(x.line)}`)
            .join(', ');
          const yes = await confirm({
            message: `${name}: the secret scan flagged ${where}. Upload anyway?`,
            initialValue: false,
          });
          if (isCancel(yes)) return;
          allowFindings = yes;
        }
        const blocked = uploadBlocker(skill, { allowFindings });
        if (blocked) {
          fail(`${name}: not uploaded — ${blocked}`);
          continue;
        }
        try {
          const out = await uploadLocalSkill(client, skill, {
            allowFindings,
            ...(f.link || f.linked ? { linked: true } : {}),
          });
          if (f.link) await linkSkill(name, dir);
          if (out.status === 'skipped') fail(`${name}: skipped — ${out.reason}`);
          else if (!quiet || out.status === 'uploaded') {
            log.success(
              `${name}: ${out.status} (${short(out.version)})${f.link ? ', linked' : ''}`,
            );
          }
        } catch (err) {
          fail(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
    if (f.link && !process.exitCode) {
      log.info(
        "This PC's relay (or local hub) now uploads a new version whenever these folders change.",
      );
    }
  });

const unlinkCommand = new Command('unlink')
  .description('Stop watching linked skill folders (the hub keeps the skill)')
  .argument('[names...]', 'skill names (default: list the linked folders)')
  .action(async (names: string[]) => {
    if (names.length === 0) {
      const links = await readSkillLinks();
      if (links.length === 0) log.info('No linked skill folders on this PC.');
      for (const l of links) process.stdout.write(`${l.name}  ${l.path}\n`);
      return;
    }
    const removed = await unlinkSkills(names);
    for (const n of names) {
      if (removed.includes(n)) log.success(`${n}: unlinked`);
      else log.warn(`${n}: was not linked`);
    }
  });

// ── refresh / update / diff / policy ────────────────────────────────────────

function describeRefresh(r: HubApiSkillRefresh): string {
  switch (r.status) {
    case 'pending':
      return `${r.name}: update pending ${short(r.from)} -> ${short(r.to)} (approve: agentbox skills update ${r.name})`;
    case 'applied':
      return `${r.name}: updated ${short(r.from)} -> ${short(r.to)}`;
    case 'up-to-date':
      return `${r.name}: up to date`;
    default:
      return `${r.name}: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`;
  }
}

const refreshCommand = new Command('refresh')
  .description('Re-fetch git and marketplace skills; new versions wait for `skills update`')
  .argument('[names...]', 'skills to refresh (default: every git and marketplace skill)')
  .option('--allow-findings', 'accept a new version the secret scan flags')
  .action(async (names: string[], f: { allowFindings?: boolean }) => {
    await withHubClient(workspaceHub(), async (client) => {
      let targets = names;
      if (targets.length === 0) {
        const lib = await client.listSkills();
        targets = lib.skills
          .filter((s) => s.origin?.kind === 'git' || s.origin?.kind === 'marketplace')
          .map((s) => s.name);
        if (targets.length === 0) {
          log.info('No git or marketplace skills in the library.');
          return;
        }
      }
      for (const n of targets) {
        try {
          const r = await client.refreshSkill(n, f.allowFindings ? { allowFindings: true } : {});
          const line = describeRefresh(r);
          if (r.status === 'failed' || r.status === 'blocked') fail(line);
          else log.info(line);
        } catch (err) {
          fail(`${n}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
  });

async function resolveBoxId(client: HubApiClient, ref: string): Promise<string | null> {
  const matches = await client.resolveBox(ref);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) fail(`no box matches '${ref}' on the hub`);
  else
    fail(
      `'${ref}' matches ${String(matches.length)} boxes; use a longer id prefix or the full name`,
    );
  return null;
}

const updateCommand = new Command('update')
  .description('Apply pending skill updates (then running boxes sync), or sync one box now')
  .argument('[names...]', 'skills whose pending update to apply')
  .option('--all', 'apply every pending update')
  .option('--box <box>', "sync this box's skills to the library now")
  .option('-y, --yes', 'apply without showing each diff and asking')
  .action(async (names: string[], f: { all?: boolean; box?: string; yes?: boolean }) => {
    await withHubClient(workspaceHub(), async (client) => {
      if (f.box) {
        const id = await resolveBoxId(client, f.box);
        if (!id) return;
        const r = await client.syncBoxSkills(id);
        if (r.status === 'failed') return fail(`${f.box}: sync failed — ${r.detail ?? ''}`);
        log.success(`${f.box}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
        return;
      }
      const lib = await client.listSkills();
      const pending = lib.skills.filter((s) => s.pending);
      if (!f.all && names.length === 0) {
        if (pending.length === 0) log.info('No pending skill updates.');
        for (const s of pending) {
          process.stdout.write(
            `${s.name}  ${short(s.current)} -> ${short(s.pending!.version)}  ${originLabel(s)}\n`,
          );
        }
        if (pending.length > 0) log.info('Apply with: agentbox skills update <name…> | --all');
        return;
      }
      const targets = f.all ? pending : names.map((n) => lib.skills.find((s) => s.name === n) ?? n);
      for (const t of targets) {
        if (typeof t === 'string') {
          fail(`${t}: not in the library`);
          continue;
        }
        if (!t.pending) {
          log.info(`${t.name}: no pending update`);
          continue;
        }
        if (!f.yes) {
          if (!interactive()) {
            fail(`${t.name}: refusing to apply without --yes (no terminal to confirm on)`);
            continue;
          }
          const d = await client.skillDiff(t.name, await adminToken());
          process.stdout.write(`${renderSkillDiff(d)}\n\n`);
          const ok = await confirm({
            message: `Apply ${t.name} ${short(t.current)} -> ${short(t.pending.version)} (${originLabel(t)})?`,
            initialValue: false,
          });
          if (isCancel(ok)) return;
          if (!ok) continue;
        }
        try {
          const r = await client.approveSkill(t.name);
          log.success(
            `${t.name}: ${short(r.from)} -> ${short(r.to)}; running boxes that have it are syncing`,
          );
        } catch (err) {
          fail(`${t.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
  });

const diffCommand = new Command('diff')
  .description("Show what a skill's pending update (or last update) changes")
  .argument('<name>', 'skill name')
  .option('--from <version>', 'base version (default: current)')
  .option('--to <version>', 'target version (default: pending, else current)')
  .option('--json', 'print JSON')
  .action(async (name: string, f: { from?: string; to?: string; json?: boolean }) => {
    await withHubClient(workspaceHub(), async (client) => {
      try {
        const d = await client.skillDiff(name, {
          ...(await adminToken()),
          ...(f.from ? { from: f.from } : {}),
          ...(f.to ? { to: f.to } : {}),
        });
        process.stdout.write(
          f.json ? JSON.stringify(d, null, 2) + '\n' : renderSkillDiff(d) + '\n',
        );
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
  });

const policyCommand = new Command('policy')
  .description("Set a skill's update policy: auto (apply at once) or manual (approve first)")
  .argument('<name>', 'skill name')
  .argument('<policy>', 'auto | manual')
  .action(async (name: string, policy: string) => {
    let p: 'auto' | 'manual' | undefined;
    try {
      p = parsePolicyFlag(policy);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    await withHubClient(workspaceHub(), async (client) => {
      try {
        const s = await client.setSkillPolicy(name, p!);
        log.success(`${s.name}: policy ${s.policy ?? p!}`);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
  });

const lsCommand = new Command('ls')
  .description('The library skills a box holds, and which are behind the library')
  .requiredOption('--box <box>', 'box id or name')
  .option('--behind', 'only skills the box holds an old version of')
  .option('--json', 'print JSON')
  .action(async (f: { box: string; behind?: boolean; json?: boolean }) => {
    await withHubClient(workspaceHub(), async (client) => {
      const id = await resolveBoxId(client, f.box);
      if (!id) return;
      const st = await client.boxSkills(id);
      const rows = f.behind ? st.skills.filter((s) => s.behind) : st.skills;
      if (f.json) {
        process.stdout.write(JSON.stringify({ ...st, skills: rows }, null, 2) + '\n');
        return;
      }
      if (!st.recordedAt) {
        log.info(`${f.box} has not pulled skills from this hub yet.`);
        return;
      }
      for (const s of rows) {
        const state =
          s.current === undefined
            ? 'removed from library'
            : s.behind
              ? `behind (library ${short(s.current)})`
              : 'current';
        process.stdout.write(
          `${s.name}  ${short(s.version)}  ${state}${s.pending ? '  update pending' : ''}\n`,
        );
      }
      if (rows.length === 0) log.info(f.behind ? 'Nothing behind.' : 'No library skills.');
    });
  });

export const skillsSubcommands: Command[] = [
  addCommand,
  importCommand,
  unlinkCommand,
  refreshCommand,
  updateCommand,
  diffCommand,
  policyCommand,
  lsCommand,
];
