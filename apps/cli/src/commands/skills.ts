/**
 * `agentbox skills` — this PC's skills next to the hub's skills library, and the
 * three moves between them: upload to the hub, download to this PC (to align one
 * PC with another), discard from the hub (docs/hub-skills-plan.md, Phase 1).
 *
 * With no action flag on a TTY it is a @clack/prompts flow; every action also
 * has a flag for scripts. Upload is never destructive (the hub keeps old
 * versions); discard and a download that replaces a different local copy are,
 * so under a non-TTY they need `--yes`. A skill the secret scan flags is
 * uploaded only after a confirm, or with `--allow-findings`.
 */
import { Command } from 'commander';
import { cancel, confirm, isCancel, log, multiselect, note, select, spinner } from '@clack/prompts';
import { loadEffectiveConfig } from '@agentbox/config';
import { homedir } from 'node:os';
import { withHubClient } from '../control-plane/with-hub.js';
import {
  skillsBindingsCommand,
  skillsDisableCommand,
  skillsEnableCommand,
} from './skills-bindings.js';
import { workspaceHub } from '../lib/workspace-ref.js';
import type { HubApiClient } from '../control-plane/hub-api-client.js';
import { skillsSubcommands } from './skills-updates.js';
import { discoverLocalSkills, type LocalSkill } from '@agentbox/sandbox-core';
import {
  compareSkills,
  downloadHubSkill,
  uploadBlocker,
  uploadLocalSkill,
  type SkillRow,
  type SkillsContext,
} from '../lib/skills/sync.js';

interface SkillsOpts {
  list?: boolean;
  json?: boolean;
  upload?: string[];
  uploadAll?: boolean;
  download?: string[];
  downloadAll?: boolean;
  discard?: string[];
  yes?: boolean;
  allowFindings?: boolean;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function statusCell(r: SkillRow): string {
  const base = baseStatus(r);
  return r.hub?.pending ? `${base}, update pending` : base;
}

function baseStatus(r: SkillRow): string {
  switch (r.status) {
    case 'same':
      return 'same';
    case 'differs':
      return r.newer === 'local' ? 'differs (local newer)' : 'differs (hub newer)';
    case 'local-only':
      return 'local only';
    case 'hub-only':
      return 'hub only';
  }
}

/** The side-by-side table, plain text so it renders in `note` and a pipe alike. */
export function renderSkillsTable(rows: readonly SkillRow[]): string {
  const header = ['SKILL', 'LOCAL', 'HUB', 'STATUS', 'SIZE', 'FROM', 'UPDATED'];
  const body = rows.map((r) => {
    const flag = r.local
      ? r.local.problems.length > 0
        ? 'invalid'
        : r.local.findings.length > 0
          ? 'flagged'
          : 'yes'
      : '-';
    const size = r.hub?.size ?? r.local?.size ?? 0;
    return [
      r.name,
      flag,
      r.hub ? 'yes' : '-',
      statusCell(r),
      formatBytes(size),
      r.hub?.source.host ?? '-',
      r.hub ? r.hub.updatedAt.slice(0, 10) : '-',
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(header), ...body.map(line)].join('\n');
}

async function loadRows(client: HubApiClient, ctx: SkillsContext): Promise<SkillRow[]> {
  const [local, hub] = await Promise.all([
    discoverLocalSkills({ home: ctx.home, maxBytes: ctx.maxBytes }),
    client.listSkills(),
  ]);
  return compareSkills(local, hub.skills);
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function describeFindings(s: LocalSkill): string {
  return s.findings.map((f) => `${f.rule} in ${f.path}:${String(f.line)}`).join(', ');
}

/** Upload the named rows. Returns false when any requested skill didn't go. */
async function doUpload(
  client: HubApiClient,
  rows: readonly SkillRow[],
  opts: { allowFindings: boolean; ask: boolean },
): Promise<boolean> {
  let allOk = true;
  for (const r of rows) {
    const skill = r.local;
    if (!skill) {
      log.warn(`${r.name}: not on this PC`);
      allOk = false;
      continue;
    }
    let allowFindings = opts.allowFindings;
    if (!allowFindings && skill.problems.length === 0 && skill.findings.length > 0 && opts.ask) {
      const yes = await confirm({
        message: `${skill.name}: the secret scan flagged ${describeFindings(skill)}. Upload anyway?`,
        initialValue: false,
      });
      if (isCancel(yes)) return false;
      allowFindings = yes;
    }
    try {
      const out = await uploadLocalSkill(client, skill, { allowFindings });
      if (out.status === 'skipped') {
        log.warn(`${out.name}: skipped — ${out.reason}`);
        allOk = false;
      } else {
        log.success(`${out.name}: ${out.status} (${out.version.slice(0, 12)})`);
      }
    } catch (err) {
      log.error(`${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
      allOk = false;
    }
  }
  return allOk;
}

async function doDownload(
  client: HubApiClient,
  rows: readonly SkillRow[],
  ctx: SkillsContext,
  opts: { yes: boolean; ask: boolean },
): Promise<boolean> {
  let allOk = true;
  for (const r of rows) {
    if (!r.hub) {
      log.warn(`${r.name}: not on the hub`);
      allOk = false;
      continue;
    }
    let overwrite = opts.yes;
    if (!overwrite && r.status === 'differs') {
      if (!opts.ask) {
        log.warn(
          `${r.name}: a different local copy exists at ${r.local!.dir}; pass --yes to replace it`,
        );
        allOk = false;
        continue;
      }
      const yes = await confirm({
        message: `${r.name}: replace the local copy at ${r.local!.dir} with the hub's version?`,
        initialValue: false,
      });
      if (isCancel(yes)) return false;
      if (!yes) continue;
      overwrite = true;
    }
    try {
      const out = await downloadHubSkill(client, r.name, ctx, { overwrite });
      if (out.status === 'skipped') {
        log.warn(`${out.name}: skipped — ${out.reason}`);
        allOk = false;
      } else {
        const link = out.links?.length ? ` (linked from ${out.links.join(', ')})` : '';
        log.success(`${out.name}: ${out.status} at ${out.dir}${link}`);
        for (const kept of out.kept ?? []) {
          log.warn(
            `${out.name}: an agent still reads its own different copy at ${kept}; remove it to use the downloaded one`,
          );
        }
      }
    } catch (err) {
      log.error(`${r.name}: ${err instanceof Error ? err.message : String(err)}`);
      allOk = false;
    }
  }
  return allOk;
}

async function doDiscard(client: HubApiClient, names: readonly string[]): Promise<boolean> {
  let allOk = true;
  for (const name of names) {
    try {
      const out = await client.discardSkill(name);
      log.success(`${name}: discarded from the hub (${String(out.removed)} file(s))`);
    } catch (err) {
      log.error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      allOk = false;
    }
  }
  return allOk;
}

function pick(rows: readonly SkillRow[], names: readonly string[]): SkillRow[] {
  return names.map((n) => rows.find((r) => r.name === n) ?? { name: n, status: 'local-only' });
}

async function runFlags(
  client: HubApiClient,
  ctx: SkillsContext,
  opts: SkillsOpts,
): Promise<boolean> {
  const ask = interactive() && !opts.yes;
  let rows = await loadRows(client, ctx);
  let ok = true;
  if (opts.upload || opts.uploadAll) {
    const chosen = opts.uploadAll
      ? rows.filter((r) => r.local && r.status !== 'same')
      : pick(rows, opts.upload ?? []);
    ok =
      (await doUpload(client, chosen, { allowFindings: opts.allowFindings === true, ask })) && ok;
    rows = await loadRows(client, ctx);
  }
  if (opts.download || opts.downloadAll) {
    const chosen = opts.downloadAll
      ? rows.filter((r) => r.hub && r.status !== 'same')
      : pick(rows, opts.download ?? []);
    ok = (await doDownload(client, chosen, ctx, { yes: opts.yes === true, ask })) && ok;
  }
  if (opts.discard) {
    if (!opts.yes) {
      if (!ask) {
        log.error(
          '--discard deletes skills from the hub; pass --yes to confirm when not on a terminal',
        );
        process.exitCode = 4;
        return false;
      }
      const yes = await confirm({
        message: `Discard ${opts.discard.join(', ')} from the hub? Every stored version is deleted.`,
        initialValue: false,
      });
      if (isCancel(yes) || !yes) return ok;
    }
    ok = (await doDiscard(client, opts.discard)) && ok;
  }
  return ok;
}

async function runTui(client: HubApiClient, ctx: SkillsContext): Promise<void> {
  for (;;) {
    const s = spinner();
    s.start('Reading local and hub skills');
    const rows = await loadRows(client, ctx);
    s.stop(
      `${String(rows.filter((r) => r.local).length)} local, ${String(rows.filter((r) => r.hub).length)} on the hub`,
    );
    note(rows.length > 0 ? renderSkillsTable(rows) : 'No skills here or on the hub.', 'Skills');
    for (const r of rows) {
      if (r.local && r.local.problems.length > 0)
        log.warn(`${r.name}: ${r.local.problems.join('; ')}`);
    }

    const action = await select({
      message: 'What next?',
      options: [
        {
          value: 'upload',
          label: 'Upload to hub',
          hint: 'local skills the hub lacks or has differently',
        },
        { value: 'download', label: 'Download to this PC', hint: 'into ~/.agents/skills' },
        { value: 'discard', label: 'Discard from hub' },
        { value: 'done', label: 'Done' },
      ],
    });
    if (isCancel(action) || action === 'done') return;

    if (action === 'upload') {
      const eligible = rows.filter(
        (r) => r.local && r.status !== 'same' && r.local.problems.length === 0,
      );
      if (eligible.length === 0) {
        log.info('Nothing to upload: every valid local skill is already on the hub.');
        continue;
      }
      const chosen = await multiselect({
        message: 'Upload which skills?',
        required: false,
        options: eligible.map((r) => ({
          value: r.name,
          label: r.name,
          hint: `${statusCell(r)}${r.local!.findings.length > 0 ? ', secret-scan findings' : ''}`,
        })),
      });
      if (isCancel(chosen) || chosen.length === 0) continue;
      await doUpload(client, pick(rows, chosen), { allowFindings: false, ask: true });
    } else if (action === 'download') {
      const eligible = rows.filter((r) => r.hub && r.status !== 'same');
      if (eligible.length === 0) {
        log.info('Nothing to download: this PC already has every hub skill.');
        continue;
      }
      const chosen = await multiselect({
        message: 'Download which skills?',
        required: false,
        options: eligible.map((r) => ({
          value: r.name,
          label: r.name,
          hint: `${statusCell(r)}, ${formatBytes(r.hub!.size)}, from ${r.hub!.source.host ?? '?'}`,
        })),
      });
      if (isCancel(chosen) || chosen.length === 0) continue;
      await doDownload(client, pick(rows, chosen), ctx, { yes: false, ask: true });
    } else {
      const onHub = rows.filter((r) => r.hub);
      if (onHub.length === 0) {
        log.info('The hub holds no skills.');
        continue;
      }
      const chosen = await multiselect({
        message: 'Discard which skills from the hub?',
        required: false,
        options: onHub.map((r) => ({
          value: r.name,
          label: r.name,
          hint: `${formatBytes(r.hub!.size)}, ${String(r.hub!.versions)} version(s)`,
        })),
      });
      if (isCancel(chosen) || chosen.length === 0) continue;
      const yes = await confirm({
        message: `Discard ${String(chosen.length)} skill(s) from the hub? Every stored version is deleted.`,
        initialValue: false,
      });
      if (isCancel(yes) || !yes) continue;
      await doDiscard(client, chosen);
    }
  }
}

function collect(value: string, prev: string[] | undefined): string[] {
  return [
    ...(prev ?? []),
    ...value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}

export const skillsCommand = new Command('skills')
  .description(
    "Compare this PC's skills with the hub's skills library; upload, download (align PCs) or discard",
  )
  .option('--list', 'print the side-by-side table and exit')
  .option('--json', 'with --list: print JSON')
  .option('--upload <names>', 'upload these local skills (comma-separated, repeatable)', collect)
  .option('--upload-all', 'upload every local skill the hub lacks or has differently')
  .option('--download <names>', 'download these hub skills to ~/.agents/skills', collect)
  .option('--download-all', 'download every hub skill this PC lacks or has differently')
  .option('--discard <names>', 'delete these skills (every version) from the hub', collect)
  .option('-y, --yes', 'skip confirms (discard; replacing a different local copy on download)')
  .option('--allow-findings', 'upload skills the secret scan flagged')
  // Without it the parent swallows a subcommand's own options (`skills
  // bindings --json` would set the parent's --json). Not inherited from the root.
  .enablePositionalOptions()
  .addCommand(skillsEnableCommand)
  .addCommand(skillsDisableCommand)
  .addCommand(skillsBindingsCommand)
  .action(async (opts: SkillsOpts) => {
    const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
    // Downloads read skill BYTES, which the hub gates like a custody read: the
    // operator's PC sends the admin token it holds; an enrolled device's own
    // token (the client's Bearer) is accepted without it; a local hub allows
    // loopback.
    const { resolveCustodyTarget } = await import('./control-plane.js');
    const custody = await resolveCustodyTarget(undefined, { quiet: true }).catch(() => null);
    const ctx: SkillsContext = {
      home: homedir(),
      maxBytes: cfg?.effective.skills.maxSkillBytes ?? 50 * 1024 * 1024,
      ...(custody?.adminToken ? { adminToken: custody.adminToken } : {}),
    };
    const acting = Boolean(
      opts.upload || opts.uploadAll || opts.download || opts.downloadAll || opts.discard,
    );
    await withHubClient(workspaceHub(), async (client) => {
      if (acting) {
        if (!(await runFlags(client, ctx, opts)) && !process.exitCode) process.exitCode = 1;
        return;
      }
      if (opts.list || opts.json || !interactive()) {
        const rows = await loadRows(client, ctx);
        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              rows.map((r) => ({
                name: r.name,
                status: r.status,
                ...(r.newer ? { newer: r.newer } : {}),
                local: r.local
                  ? {
                      dir: r.local.dir,
                      version: r.local.treeSha,
                      size: r.local.size,
                      problems: r.local.problems,
                      findings: r.local.findings,
                      blocked: uploadBlocker(r.local),
                    }
                  : null,
                hub: r.hub ?? null,
              })),
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stdout.write(renderSkillsTable(rows) + '\n');
        }
        return;
      }
      try {
        await runTui(client, ctx);
      } catch (err) {
        cancel(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
  });

for (const sub of skillsSubcommands) skillsCommand.addCommand(sub);
