// A line diff for the pending-update view: LCS over lines, collapsed to hunks
// with a few lines of context. Skill files are small; past MAX_CELLS the diff
// falls back to "all removed, all added" rather than allocating a huge table.

export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
}

/** A gap between hunks: `skipped` unchanged lines were left out. */
export interface DiffGap {
  op: '…';
  skipped: number;
}

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  // An empty side (an added or removed file) has no lines, not one empty line.
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ op: '-' as const, text })),
      ...b.map((text) => ({ op: '+' as const, text })),
    ];
  }
  // lcs[i][j] = LCS length of a[i..] and b[j..], flattened.
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + j + 1]! + 1
          : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
      out.push({ op: '-', text: a[i++]! });
    } else {
      out.push({ op: '+', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ op: '-', text: a[i++]! });
  while (j < b.length) out.push({ op: '+', text: b[j++]! });
  return out;
}

/** Keep `context` unchanged lines around each change; fold the rest into gaps. */
export function hunks(lines: DiffLine[], context = 3): (DiffLine | DiffGap)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.op === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });
  const out: (DiffLine | DiffGap)[] = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped > 0) out.push({ op: '…', skipped });
      skipped = 0;
      out.push(l);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ op: '…', skipped });
  return out;
}
