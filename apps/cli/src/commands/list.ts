import { listBoxes, type ListedBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';

interface ListOptions {
  json?: boolean;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return `${String(diffSec)}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${String(diffMin)}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${String(diffHr)}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${String(diffDay)}d ago`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderTable(boxes: ListedBox[]): string {
  const rows = boxes.map((b) => [
    typeof b.projectIndex === 'number' ? String(b.projectIndex) : '',
    b.id,
    b.name,
    b.state,
    truncate(b.image, 28),
    relativeTime(b.createdAt),
    truncate(b.workspacePath, 50),
  ]);
  const header = ['N', 'ID', 'NAME', 'STATE', 'IMAGE', 'CREATED', 'WORKSPACE'];
  const all = [header, ...rows];
  const widths = header.map((_, col) => Math.max(...all.map((r) => (r[col] ?? '').length)));
  return all
    .map((row) =>
      row
        .map((cell, i) => (cell ?? '').padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export const listCommand = new Command('list')
  .alias('ls')
  .description('List all known agent boxes')
  .option('-j, --json', 'machine-readable JSON output')
  .action(async (opts: ListOptions) => {
    const boxes = await listBoxes();
    if (opts.json) {
      process.stdout.write(JSON.stringify(boxes, null, 2) + '\n');
      return;
    }
    if (boxes.length === 0) {
      process.stdout.write('no boxes — run `agentbox create` to make one\n');
      return;
    }
    process.stdout.write(renderTable(boxes) + '\n');
  });
