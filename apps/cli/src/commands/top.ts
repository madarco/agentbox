import { Command } from 'commander';
import { findProjectRoot } from '@agentbox/config';
import {
  agentboxHomeBytes,
  allCheckpointImagesBytes,
  boxResourceStats,
  listBoxes,
  type ListedBox,
} from '@agentbox/sandbox-docker';
import type { BoxResourceStats } from '@agentbox/core';
import { resolveBoxOrExit } from '../box-ref.js';
import { fmtBytes, fmtPercent } from '../fmt.js';
import { watchRender } from '../watch.js';
import { handleLifecycleError } from './_errors.js';

interface TopOptions {
  project?: boolean;
  once?: boolean;
  json?: boolean;
  interval?: string;
}

const COLS = ['BOX', 'STATE', 'CPU%', 'MEM USAGE / LIMIT', 'MEM%', 'PIDS', 'DISK', 'NET I/O'];

function row(name: string, state: string, s: BoxResourceStats): string[] {
  const mem = `${fmtBytes(s.memUsedBytes)} / ${fmtBytes(s.memLimitBytes)}`;
  const net =
    s.netRxBytes === null && s.netTxBytes === null
      ? '—'
      : `${fmtBytes(s.netRxBytes)} / ${fmtBytes(s.netTxBytes)}`;
  return [
    name,
    state,
    fmtPercent(s.cpuPercent),
    s.live ? mem : '—',
    fmtPercent(s.memPercent),
    s.pids === null ? '—' : String(s.pids),
    fmtBytes(s.diskUsedBytes),
    s.live ? net : '—',
  ];
}

function renderTable(rows: string[][]): string {
  const all = [COLS, ...rows];
  const widths = COLS.map((_, c) => Math.max(...all.map((r) => r[c]!.length)));
  return all
    .map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join('  ').trimEnd())
    .join('\n');
}

async function selectBoxes(
  idOrName: string | undefined,
  opts: TopOptions,
): Promise<ListedBox[]> {
  const boxes = await listBoxes();
  if (idOrName === undefined) {
    // Default: every box on the host. --project narrows to the cwd's project.
    // An empty result is not an error here: watch mode stays up and picks up
    // boxes as they're created. Callers render a placeholder.
    if (!opts.project) return boxes;
    const project = await findProjectRoot(process.cwd());
    return boxes.filter((b) => b.projectRoot === project.root);
  }
  const picked = await resolveBoxOrExit(idOrName);
  return boxes.filter((b) => b.id === picked.id);
}

async function snapshot(
  idOrName: string | undefined,
  opts: TopOptions,
): Promise<{ boxes: ListedBox[]; stats: BoxResourceStats[] }> {
  const boxes = await selectBoxes(idOrName, opts);
  const stats = await Promise.all(boxes.map((b) => boxResourceStats(b)));
  return { boxes, stats };
}

async function renderProjectFooters(): Promise<string> {
  // Two independent disk numbers, no overlap: checkpoint *images* live in
  // Docker's image store (not under ~/.agentbox); everything else agentbox
  // keeps on the host — box run dirs, exports, host clones — is under
  // ~/.agentbox and summed there.
  const parts: string[] = [];
  const [ckpt, home] = await Promise.all([
    allCheckpointImagesBytes(),
    agentboxHomeBytes(),
  ]);
  if (home !== null) parts.push(`~/.agentbox: ${fmtBytes(home)}`);
  if (ckpt !== null) parts.push(`checkpoints: ${fmtBytes(ckpt)}`);
  return parts.length > 0 ? `\n\nSYSTEM: ${parts.join(' - ')}` : '';
}

export const topCommand = new Command('top')
  .description('Live resource monitor (cpu/mem/pids/disk) for a box, the project, or every box')
  .argument(
    '[box]',
    "box ref (default: every box on the host; --project narrows to the cwd's project)",
  )
  .option('-p, --project', "show only boxes in the cwd's project")
  .option('--once', 'print a single snapshot instead of watching')
  .option('-j, --json', 'machine-readable JSON (implies --once)')
  .option('--interval <seconds>', 'refresh interval', '2')
  .action(async (idOrName: string | undefined, opts: TopOptions) => {
    try {
      if (opts.json) {
        const { boxes, stats } = await snapshot(idOrName, opts);
        process.stdout.write(
          JSON.stringify(
            boxes.map((b, i) => ({ box: b.name, state: b.state, ...stats[i]! })),
            null,
            2,
          ) + '\n',
        );
        return;
      }

      const produce = async (watching: boolean): Promise<string> => {
        const { boxes, stats } = await snapshot(idOrName, opts);
        const scope = opts.project ? 'no boxes for this project' : 'no boxes';
        const header =
          boxes.length === 0
            ? watching
              ? `${scope} (waiting...)`
              : scope
            : renderTable(boxes.map((b, i) => row(b.name, b.state, stats[i]!)));
        return header + (await renderProjectFooters());
      };

      if (opts.once) {
        process.stdout.write((await produce(false)) + '\n');
        return;
      }
      await watchRender(() => produce(true), opts.interval);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
