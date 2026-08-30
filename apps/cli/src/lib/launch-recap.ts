/**
 * `printLaunchRecap` — the single bordered "card" shown after an agent box is
 * provisioned, replacing the old scatter of `●` rows (`id:`/`provider:`/
 * `sandboxId:`) and the split detach/reattach hints. Rendered identically for
 * docker and cloud, for `claude` / `codex` / `opencode` / `shell`, so the
 * post-create surface stays consistent across every launch path.
 *
 * The card shows the box name (+ source checkpoint when started from one), the
 * project folder (the dir that actually held `agentbox.yaml`, which may be a
 * parent of cwd), the `from → to` branch mapping, and the detach/reattach
 * instructions on the last line.
 */
import { homedir } from 'node:os';
import { note } from '@clack/prompts';
import type { AgentMode, BoxRecord } from '@agentbox/core';
import { currentHostBranch } from './from-branch.js';

export interface LaunchRecapArgs {
  record: BoxRecord;
  mode: AgentMode;
  /** Reattach ref shown in the hint: the per-project index `n` or the box name. */
  reattach: string;
  /** Host repo path — used to resolve the base branch label when none was given. */
  workspacePath: string;
  /** Resolved `--from-branch` (base ref), if any. */
  fromBranch?: string;
  /** Resolved `--use-branch` (reused existing branch), if any. */
  useBranch?: string;
  /** Source checkpoint the box started from, when applicable. */
  checkpointRef?: string;
  /** true → attaching now (detach hint); false → background create (attach hint). */
  attaching: boolean;
}

/** Collapse an absolute path under $HOME to a `~/…` form for display. */
function homeShorten(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/**
 * clack's `note` wraps every body line in `color.dim`, which renders dark gray.
 * Prefix each line with reset + bright-white so the recap reads in plain white;
 * the leading reset cancels the dim attribute clack opened. `strip-ansi` length
 * (clack's padding math) ignores these codes, so box alignment is unaffected.
 */
function whiten(text: string): string {
  if (process.env.NO_COLOR) return text;
  return text
    .split('\n')
    .map((line) => `\x1b[0m\x1b[97m${line}\x1b[0m`)
    .join('\n');
}

export async function printLaunchRecap(args: LaunchRecapArgs): Promise<void> {
  const { record } = args;
  const rows: Array<[string, string]> = [];

  rows.push([
    'box',
    args.checkpointRef ? `${record.name} (${args.checkpointRef})` : record.name,
  ]);

  if (record.projectRoot) {
    rows.push(['project', homeShorten(record.projectRoot)]);
  }

  const toBranch = record.gitWorktrees?.find((w) => w.kind === 'root')?.branch;
  if (toBranch) {
    if (args.useBranch) {
      rows.push(['branch', `${toBranch} (reused)`]);
    } else {
      const base = args.fromBranch ?? (await currentHostBranch(args.workspacePath)) ?? 'HEAD';
      rows.push(['branch', `${base} → ${toBranch}`]);
    }
  }

  const pad = Math.max(...rows.map(([label]) => label.length)) + 2;
  const body = rows.map(([label, value]) => `${label.padEnd(pad)}${value}`).join('\n');

  const instruction = args.attaching
    ? `Ctrl+a d to detach. Reattach with: agentbox ${args.mode} attach ${args.reattach}`
    : `Attach with: agentbox ${args.mode} attach ${args.reattach}`;

  note(whiten(`${body}\n\n${instruction}`));
}
