/**
 * `agentbox skills` — this PC's skills next to the hub's skills library, and the
 * three moves between them: upload to the hub, download to this PC (to align one
 * PC with another), discard from the hub (docs/hub-skills-plan.md, Phase 1).
 *
 * With no action flag on a TTY it is one table screen (cli-kit `tableSelect`):
 * the bulk actions above the skills, each row selectable for its own actions; every action also
 * has a flag for scripts. Upload is never destructive (the hub keeps old
 * versions); discard and a download that replaces a different local copy are,
 * so under a non-TTY they need `--yes`. A skill the secret scan flags is
 * uploaded only after a confirm, or with `--allow-findings`.
 */
import { Command } from 'commander';
import { cancel, confirm, isCancel, log, multiselect, note, select, spinner } from '@clack/prompts';
import { loadEffectiveConfig } from '@agentbox/config';
import { tableSelect, type TableTone } from '@agentbox/cli-kit';
import { homedir } from 'node:os';
import { withHubClient } from '../control-plane/with-hub.js';
import {
  skillsBindingsCommand,
  skillsDisableCommand,
  skillsEnableCommand,
} from './skills-bindings.js';
import { workspaceHub } from '../lib/workspace-ref.js';
import { SKILL_NAME_RE } from '../lib/skills/selection.js';
import type { HubApiClient } from '../control-plane/hub-api-client.js';
import { skillsSubcommands } from './skills-updates.js';
import { discoverLocalSkills, isOutOfSync, type LocalSkill } from '@agentbox/sandbox-core';
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
    case 'skipped':
      return 'skipped, not synced';
  }
}

const SKILL_HEADERS = ['SKILL', 'LOCAL', 'HUB', 'STATUS', 'SIZE', 'FROM', 'UPDATED'];

function localFlag(r: SkillRow): string {
  if (!r.local) return '-';
  if (r.local.problems.length > 0) return 'invalid';
  return r.local.findings.length > 0 ? 'flagged' : 'yes';
}

/** One table row's cells, shared by the plain table and the TUI. */
function skillCells(r: SkillRow): string[] {
  return [
    r.name,
    localFlag(r),
    r.hub ? 'yes' : '-',
    statusCell(r),
    formatBytes(r.hub?.size ?? r.local?.size ?? 0),
    r.hub?.source.host ?? '-',
    r.hub ? r.hub.updatedAt.slice(0, 10) : '-',
  ];
}

/** The TUI's cells: a skipped skill reads plainly "skipped". */
function skillTuiCells(r: SkillRow): string[] {
  const cells = skillCells(r);
  if (r.status === 'skipped') cells[3] = 'skipped';
  return cells;
}

function skillTones(r: SkillRow): (TableTone | undefined)[] {
  // A skipped skill reaches no box: the whole row is dimmed.
  if (r.status === 'skipped') return SKILL_HEADERS.map(() => 'dim');
  const flag = localFlag(r);
  const status: TableTone | undefined =
    r.status === 'same' ? 'green' : r.status === 'differs' ? 'yellow' : undefined;
  return [
    undefined,
    flag === 'invalid' ? 'red' : flag === 'flagged' ? 'yellow' : undefined,
    undefined,
    status,
  ];
}

/** The side-by-side table, plain text so it renders in a pipe. */
export function renderSkillsTable(rows: readonly SkillRow[]): string {
  const body = rows.map(skillCells);
  const widths = SKILL_HEADERS.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(SKILL_HEADERS), ...body.map(line)].join('\n');
}

async function loadRows(client: HubApiClient, ctx: SkillsContext): Promise<SkillRow[]> {
  const [local, hub] = await Promise.all([
    discoverLocalSkills({ home: ctx.home, maxBytes: ctx.maxBytes }),
    client.listSkills(),
  ]);
  const rows = compareSkills(local, hub.skills, hub.skipped ?? []);
  // A skipped name on neither side keeps a row, so its skip can still be cleared.
  for (const name of hub.skipped ?? []) {
    if (!rows.some((r) => r.name === name)) rows.push({ name, status: 'skipped' });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Rows an upload or download may move: not in sync (never a skipped one). */
function movable(r: SkillRow): boolean {
  return isOutOfSync(r.status);
}

/** The hint for a skip refusal, where a row says why it didn't move. */
const SKIPPED_HINT = 'skipped (never synced); `agentbox skills unskip` it first';

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
    if (r.status === 'skipped') {
      log.warn(`${r.name}: ${SKIPPED_HINT}`);
      allOk = false;
      continue;
    }
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
    if (r.status === 'skipped') {
      log.warn(`${r.name}: ${SKIPPED_HINT}`);
      allOk = false;
      continue;
    }
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

async function setSkipped(client: HubApiClient, name: string, skip: boolean): Promise<boolean> {
  try {
    await client.setSkillSkipped(name, skip);
    log.success(skip ? `${name}: skipped, never synced` : `${name}: syncs again`);
    return true;
  } catch (err) {
    log.error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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
      ? rows.filter((r) => r.local && movable(r))
      : pick(rows, opts.upload ?? []);
    ok =
      (await doUpload(client, chosen, { allowFindings: opts.allowFindings === true, ask })) && ok;
    rows = await loadRows(client, ctx);
  }
  if (opts.download || opts.downloadAll) {
    const chosen = opts.downloadAll
      ? rows.filter((r) => r.hub && movable(r))
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

type BulkAction = '+upload' | '+download' | '+skip' | '+discard';

async function runTui(client: HubApiClient, ctx: SkillsContext): Promise<void> {
  let cursorAt: string | undefined;
  for (;;) {
    const s = spinner();
    s.start('Reading local and hub skills');
    const rows = await loadRows(client, ctx);
    s.stop('Skills read');
    for (const r of rows) {
      if (r.local && r.local.problems.length > 0)
        log.warn(`${r.name}: ${r.local.problems.join('; ')}`);
    }
    const picked = await tableSelect<string>({
      title: 'Skills',
      subtitle: `${String(rows.filter((r) => r.local).length)} local, ${String(rows.filter((r) => r.hub).length)} on the hub`,
      actions: [
        {
          value: '+upload',
          label: 'Upload to hub…',
          hint: 'local skills the hub lacks or has differently',
        },
        { value: '+download', label: 'Download to this PC…', hint: 'into ~/.agents/skills' },
        {
          value: '+skip',
          label: 'Choose which skills sync…',
          hint: 'unticked ones are skipped for good',
        },
        { value: '+discard', label: 'Discard from hub…' },
      ],
      headers: SKILL_HEADERS,
      // SKILL, STATUS, LOCAL, HUB, SIZE, UPDATED, FROM: what a narrow terminal keeps.
      priority: [0, 3, 1, 2, 4, 6, 5],
      rows: rows.map((r) => ({ value: r.name, cells: skillTuiCells(r), tones: skillTones(r) })),
      emptyText: 'No skills here or on the hub.',
      ...(cursorAt ? { cursorAt } : {}),
    });
    if (picked.kind === 'quit') return;
    if (picked.kind === 'cancel') {
      cancel('Cancelled.');
      process.exitCode = 130;
      return;
    }
    cursorAt = picked.value;
    if (picked.kind === 'row') {
      const row = rows.find((r) => r.name === picked.value);
      if (row) await skillMenu(client, ctx, row);
      continue;
    }
    await bulkAction(client, ctx, rows, picked.value as BulkAction);
  }
}

function skillDetail(r: SkillRow): string {
  const lines = [`status    ${statusCell(r)}`];
  if (r.local) {
    lines.push(`local     ${r.local.dir} (${formatBytes(r.local.size)})`);
    if (r.local.problems.length > 0) lines.push(`problems  ${r.local.problems.join('; ')}`);
    if (r.local.findings.length > 0) lines.push(`findings  ${describeFindings(r.local)}`);
  }
  if (r.hub) {
    lines.push(
      `hub       ${formatBytes(r.hub.size)}, ${String(r.hub.versions)} version(s), from ${r.hub.source.host ?? '?'}, ${r.hub.updatedAt.slice(0, 10)}`,
    );
  }
  return lines.join('\n');
}

/** What can be done with one skill: the single-skill form of the bulk actions. */
async function skillMenu(client: HubApiClient, ctx: SkillsContext, r: SkillRow): Promise<void> {
  note(skillDetail(r), r.name);
  const options: Array<{ value: string; label: string; hint?: string }> = [];
  if (r.local && movable(r) && r.local.problems.length === 0) {
    options.push({ value: 'upload', label: 'Upload to hub' });
  }
  if (r.hub && movable(r)) {
    options.push({
      value: 'download',
      label: 'Download to this PC',
      ...(r.status === 'differs' ? { hint: 'replaces the local copy' } : {}),
    });
  }
  if (SKILL_NAME_RE.test(r.name)) {
    options.push(
      r.status === 'skipped'
        ? { value: 'unskip', label: 'Unskip', hint: 'boxes get it again' }
        : {
            value: 'skip',
            label: 'Skip (boxes stop getting it)',
            hint: 'never synced or delivered; nothing is deleted',
          },
    );
  }
  if (r.hub) options.push({ value: 'discard', label: 'Discard from hub', hint: 'every version' });
  options.push({ value: 'back', label: 'Back' });
  const action = await select({ message: r.name, options });
  if (isCancel(action) || action === 'back') return;
  if (action === 'upload') await doUpload(client, [r], { allowFindings: false, ask: true });
  else if (action === 'download') await doDownload(client, [r], ctx, { yes: false, ask: true });
  else if (action === 'skip' || action === 'unskip')
    await setSkipped(client, r.name, action === 'skip');
  else {
    const yes = await confirm({
      message: `Discard ${r.name} from the hub? Every stored version is deleted.`,
      initialValue: false,
    });
    if (isCancel(yes) || !yes) return;
    await doDiscard(client, [r.name]);
  }
}

async function bulkAction(
  client: HubApiClient,
  ctx: SkillsContext,
  rows: readonly SkillRow[],
  action: BulkAction,
): Promise<void> {
  if (action === '+upload') {
    const eligible = rows.filter((r) => r.local && movable(r) && r.local.problems.length === 0);
    if (eligible.length === 0) {
      log.info('Nothing to upload: every valid local skill is already on the hub.');
      return;
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
    if (isCancel(chosen) || chosen.length === 0) return;
    await doUpload(client, pick(rows, chosen), { allowFindings: false, ask: true });
  } else if (action === '+download') {
    const eligible = rows.filter((r) => r.hub && movable(r));
    if (eligible.length === 0) {
      log.info('Nothing to download: this PC already has every hub skill.');
      return;
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
    if (isCancel(chosen) || chosen.length === 0) return;
    await doDownload(client, pick(rows, chosen), ctx, { yes: false, ask: true });
  } else if (action === '+skip') {
    // A local folder whose name is no valid skill name can't be uploaded
    // anyway, and the hub refuses to skip it (400): name it, don't offer it.
    const skippable = rows.filter((r) => SKILL_NAME_RE.test(r.name));
    const odd = rows.filter((r) => !SKILL_NAME_RE.test(r.name)).map((r) => r.name);
    if (odd.length > 0) log.info(`Not skippable (not a valid skill name): ${odd.join(', ')}`);
    if (skippable.length === 0) {
      log.info('No skills here or on the hub.');
      return;
    }
    const synced = await multiselect({
      message: 'Which skills sync? (untick to skip)',
      required: false,
      initialValues: skippable.filter((r) => r.status !== 'skipped').map((r) => r.name),
      options: skippable.map((r) => ({ value: r.name, label: r.name, hint: statusCell(r) })),
    });
    if (isCancel(synced)) return;
    const keep = new Set(synced);
    for (const r of skippable) {
      const skip = !keep.has(r.name);
      if (skip === (r.status === 'skipped')) continue;
      await setSkipped(client, r.name, skip);
    }
  } else {
    const onHub = rows.filter((r) => r.hub);
    if (onHub.length === 0) {
      log.info('The hub holds no skills.');
      return;
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
    if (isCancel(chosen) || chosen.length === 0) return;
    const yes = await confirm({
      message: `Discard ${String(chosen.length)} skill(s) from the hub? Every stored version is deleted.`,
      initialValue: false,
    });
    if (isCancel(yes) || !yes) return;
    await doDiscard(client, chosen);
  }
}

/**
 * `agentbox skills skip|unskip <names...>`: mark skills "never sync" on the hub
 * (or sync them again). A skipped skill is never uploaded, downloaded, seeded
 * or delivered to a box; nothing is deleted. Works for a skill only on this PC.
 */
function skipCommand(verb: 'skip' | 'unskip'): Command {
  return new Command(verb)
    .description(
      verb === 'skip'
        ? 'Never sync these skills (hub <-> PCs and boxes); nothing is deleted'
        : 'Sync these skipped skills again',
    )
    .argument('<names...>', 'skill names')
    .action(async (names: string[]) => {
      const bad = names.filter((n) => !SKILL_NAME_RE.test(n));
      if (bad.length > 0) {
        process.stderr.write(`invalid skill name(s): ${bad.join(', ')}\n`);
        process.exitCode = 1;
        return;
      }
      await withHubClient(workspaceHub(), async (client) => {
        let ok = true;
        for (const n of names) ok = (await setSkipped(client, n, verb === 'skip')) && ok;
        if (!ok) process.exitCode = 1;
      });
    });
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
  .addCommand(skipCommand('skip'))
  .addCommand(skipCommand('unskip'))
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
