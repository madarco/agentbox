import fs from 'node:fs';
import net from 'node:net';
import type { Terminal as XtermTerminal } from '@xterm/headless';
import { harnessDir, metaPath, pidPath, sockPath, type SessionMeta } from './paths.js';
import type { Request, Response } from './client.js';

interface IPtyLike {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface PtySpawn {
  (
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ): IPtyLike;
}

interface DaemonOpts {
  id: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  command: string;
  args: string[];
}

/**
 * Long-lived daemon entry: spawn the inner command in a PTY, mirror its
 * output into an xterm-headless terminal, and serve JSON-RPC requests over
 * a per-session unix-domain socket until the PTY exits or `op: 'stop'`
 * arrives. Called from drive.ts when invoked in daemon mode.
 */
export async function runDaemon(opts: DaemonOpts): Promise<number> {
  const ptyMod = (await import('@homebridge/node-pty-prebuilt-multiarch')) as Record<
    string,
    unknown
  >;
  const xtermMod = (await import('@xterm/headless')) as Record<string, unknown>;
  const ptySpawn =
    (ptyMod['spawn'] as unknown) ??
    (ptyMod['default'] as Record<string, unknown> | undefined)?.['spawn'];
  const Terminal =
    (xtermMod['Terminal'] as unknown) ??
    (xtermMod['default'] as Record<string, unknown> | undefined)?.['Terminal'];
  if (typeof ptySpawn !== 'function' || typeof Terminal !== 'function') {
    throw new Error('drive: @homebridge/node-pty-prebuilt-multiarch or @xterm/headless missing');
  }

  fs.mkdirSync(harnessDir(), { recursive: true });

  const term = new (Terminal as new (o: {
    cols: number;
    rows: number;
    allowProposedApi: boolean;
    scrollback: number;
    convertEol: boolean;
  }) => XtermTerminal)({
    cols: opts.cols,
    rows: opts.rows,
    allowProposedApi: true,
    scrollback: 1000,
    convertEol: false,
  });

  const pty = (ptySpawn as PtySpawn)(opts.command, opts.args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
  });

  let exitCode = 0;
  let exited = false;
  pty.onData((d) => {
    term.write(d);
  });
  pty.onExit(({ exitCode: code }) => {
    exitCode = code;
    exited = true;
    // Give clients a brief grace to read the final screen, then quit.
    setTimeout(() => shutdown(), 250);
  });

  // Persist metadata so `drive list` can introspect without speaking RPC.
  const meta: SessionMeta = {
    id: opts.id,
    pid: process.pid,
    command: opts.command,
    args: opts.args,
    cols: opts.cols,
    rows: opts.rows,
    startedAt: new Date().toISOString(),
    cwd: opts.cwd,
    socket: sockPath(opts.id),
  };
  fs.writeFileSync(metaPath(opts.id), JSON.stringify(meta, null, 2));
  fs.writeFileSync(pidPath(opts.id), String(process.pid));

  // Clean stale socket from a previous (crashed) daemon.
  try {
    fs.unlinkSync(sockPath(opts.id));
  } catch {
    /* not present */
  }

  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch (e) {
        respond(sock, { ok: false, error: `bad json: ${(e as Error).message}` });
        return;
      }
      handle(req).then(
        (res) => respond(sock, res),
        (e) => respond(sock, { ok: false, error: (e as Error).message }),
      );
    });
    sock.on('error', () => {
      /* peer hung up */
    });
  });

  server.listen(sockPath(opts.id));

  async function handle(req: Request): Promise<Response> {
    switch (req.op) {
      case 'screen': {
        const text = renderScreen(term, {
          ansi: req.ansi === true,
          withCursor: req.withCursor === true,
          range: req.rows,
        });
        return { ok: true, text };
      }
      case 'send': {
        if (exited) return { ok: false, error: 'pty has exited' };
        pty.write(req.data);
        return { ok: true };
      }
      case 'resize': {
        if (exited) return { ok: false, error: 'pty has exited' };
        pty.resize(req.cols, req.rows);
        term.resize(req.cols, req.rows);
        meta.cols = req.cols;
        meta.rows = req.rows;
        fs.writeFileSync(metaPath(opts.id), JSON.stringify(meta, null, 2));
        return { ok: true };
      }
      case 'meta': {
        return {
          ok: true,
          meta: {
            id: opts.id,
            pid: process.pid,
            command: opts.command,
            args: opts.args,
            cols: meta.cols,
            rows: meta.rows,
            startedAt: meta.startedAt,
            cwd: opts.cwd,
            alive: !exited,
            cursor: { x: term.buffer.active.cursorX, y: term.buffer.active.cursorY },
          },
        };
      }
      case 'stop': {
        try {
          pty.kill();
        } catch {
          /* already dead */
        }
        setTimeout(() => shutdown(), 50);
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown op` };
    }
  }

  function respond(sock: net.Socket, res: Response): void {
    try {
      sock.write(JSON.stringify(res) + '\n');
      sock.end();
    } catch {
      /* socket closed by peer */
    }
  }

  function shutdown(): void {
    try {
      server.close();
    } catch {
      /* */
    }
    for (const p of [sockPath(opts.id), pidPath(opts.id), metaPath(opts.id)]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* gone */
      }
    }
    process.exit(exitCode);
  }

  process.on('SIGTERM', () => {
    try {
      pty.kill();
    } catch {
      /* */
    }
    setTimeout(() => shutdown(), 50);
  });
  process.on('SIGINT', () => {
    try {
      pty.kill();
    } catch {
      /* */
    }
    setTimeout(() => shutdown(), 50);
  });

  return new Promise<number>(() => {
    /* never resolves; shutdown() calls process.exit */
  });
}

interface RenderOpts {
  ansi: boolean;
  withCursor: boolean;
  range?: [number, number];
}

interface XtermBufferCell {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough?(): number;
}

function renderScreen(term: XtermTerminal, opts: RenderOpts): string {
  const buf = term.buffer.active;
  const rows = term.rows;
  const cols = term.cols;
  const [start, end] = opts.range ?? [0, rows - 1];
  const lo = Math.max(0, start);
  const hi = Math.min(rows - 1, end);
  const lines: string[] = [];
  for (let y = lo; y <= hi; y++) {
    const line = buf.getLine(buf.viewportY + y);
    if (!line) {
      lines.push('');
      continue;
    }
    if (!opts.ansi) {
      // `true` => trim trailing whitespace from the row.
      lines.push(line.translateToString(true));
      continue;
    }
    lines.push(composeRowAnsi(line, cols));
  }
  let out = lines.join('\n');
  if (opts.withCursor) {
    out += `\n[cursor x=${buf.cursorX} y=${buf.cursorY}]`;
  }
  return out;
}

interface XtermBufferLine {
  getCell(x: number, cell?: XtermBufferCell): XtermBufferCell | undefined;
}

// Best-effort ANSI re-encoding: walks cells, emits SGR runs for fg/bg/attrs.
// Not byte-perfect with the original output (xterm normalizes), but enough
// to eyeball colors in a screen dump.
function composeRowAnsi(line: XtermBufferLine, cols: number): string {
  let out = '';
  let lastSgr = '';
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x) as XtermBufferCell | undefined;
    if (!cell) {
      out += ' ';
      continue;
    }
    const w = cell.getWidth();
    if (w === 0) continue; // trailing half of a wide char
    const sgr = sgrFor(cell);
    if (sgr !== lastSgr) {
      out += sgr;
      lastSgr = sgr;
    }
    const ch = cell.getChars();
    out += ch.length > 0 ? ch : ' ';
  }
  if (lastSgr !== '') out += '\x1b[0m';
  return out;
}

function sgrFor(cell: XtermBufferCell): string {
  const parts: string[] = ['0'];
  // fg
  if (cell.isFgDefault()) parts.push('39');
  else if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    parts.push(`38;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
  } else {
    const n = cell.getFgColor();
    if (n < 8) parts.push(String(30 + n));
    else if (n < 16) parts.push(String(90 + (n - 8)));
    else parts.push(`38;5;${n}`);
  }
  // bg
  if (cell.isBgDefault()) parts.push('49');
  else if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    parts.push(`48;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
  } else {
    const n = cell.getBgColor();
    if (n < 8) parts.push(String(40 + n));
    else if (n < 16) parts.push(String(100 + (n - 8)));
    else parts.push(`48;5;${n}`);
  }
  if (cell.isBold()) parts.push('1');
  if (cell.isDim()) parts.push('2');
  if (cell.isItalic()) parts.push('3');
  if (cell.isUnderline()) parts.push('4');
  if (cell.isInverse()) parts.push('7');
  if (cell.isInvisible()) parts.push('8');
  if (cell.isStrikethrough?.()) parts.push('9');
  return `\x1b[${parts.join(';')}m`;
}
