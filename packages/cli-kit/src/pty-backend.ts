import type { Terminal as XtermTerminal } from '@xterm/headless';

/**
 * The `@xterm/headless` `Terminal` class. Injected (not imported) because
 * @xterm/headless is CJS — a static ESM named import breaks Node's loader for
 * the whole CLI, so callers dynamic-import it and pass the ctor through.
 *
 * Used by the dashboard (for its xterm-headless screen-state mirror). The
 * wrapped-pty wrapper does not need it — the inner program writes raw bytes
 * directly to the user's terminal, no parsing required.
 */
export type TerminalCtor = new (opts: {
  cols: number;
  rows: number;
  allowProposedApi: boolean;
  scrollback: number;
  convertEol: boolean;
}) => XtermTerminal;

/**
 * Minimal shape of a node-pty IPty (avoids a hard type dep on the optional
 * module — node-pty is in optionalDependencies, may not be installed).
 */
export interface IPtyLike {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
) => IPtyLike;

export interface PtyBackend {
  ptySpawn: PtySpawn;
  /** Present for callers that also need the xterm headless ctor (dashboard). */
  termCtor: TerminalCtor;
}

/**
 * Dynamic-load the optional pty + xterm/headless backends. Returns null
 * when either prebuild is missing (we don't throw — callers decide how to
 * degrade). Centralized here so the dashboard and the wrapped-pty wrapper
 * use the same exact load dance.
 */
export async function loadPtyBackend(): Promise<PtyBackend | null> {
  try {
    const ptyMod = (await import('@homebridge/node-pty-prebuilt-multiarch')) as Record<
      string,
      unknown
    >;
    const xtermMod = (await import('@xterm/headless')) as Record<string, unknown>;
    const spawn =
      (ptyMod['spawn'] as unknown) ??
      (ptyMod['default'] as Record<string, unknown> | undefined)?.['spawn'];
    const Terminal =
      (xtermMod['Terminal'] as unknown) ??
      (xtermMod['default'] as Record<string, unknown> | undefined)?.['Terminal'];
    if (typeof spawn !== 'function' || typeof Terminal !== 'function') {
      return null;
    }
    return {
      ptySpawn: spawn as unknown as PtySpawn,
      termCtor: Terminal as unknown as TerminalCtor,
    };
  } catch {
    return null;
  }
}
