import { execa } from 'execa';
import {
  HISTORY_BINDINGS_FILE,
  parseBindingLog,
  type HistoryBinding,
  type HistoryFileSource,
} from '@agentbox/core';

/**
 * Reads a docker box's agent files from the host. A running box is read with
 * `docker exec`; a paused or stopped one (a destroy's final flush) through a
 * throwaway container that mounts the box's volumes (`--volumes-from`), plus
 * `docker cp` for the binding log, which lives on the box's own writable layer.
 */

const BOX_HOME = '/home/vscode';
const EXEC_TIMEOUT_MS = 60_000;

export type DockerRunner = (args: string[], opts?: { signal?: AbortSignal }) => Promise<Buffer>;

const defaultRunner: DockerRunner = async (args, opts) => {
  const r = await execa('docker', args, {
    encoding: 'buffer',
    timeout: EXEC_TIMEOUT_MS,
    reject: false,
    stripFinalNewline: false,
    ...(opts?.signal ? { cancelSignal: opts.signal } : {}),
  });
  if (opts?.signal?.aborted) throw new Error(`docker ${args[0] ?? ''} aborted`);
  if (r.exitCode !== 0) {
    throw new Error(
      `docker ${args[0] ?? ''} exited ${String(r.exitCode)}: ${Buffer.from(r.stderr ?? [])
        .toString('utf8')
        .trim()
        .slice(0, 200)}`,
    );
  }
  return Buffer.from(r.stdout ?? []);
};

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The single regular file in a `docker cp … -` tar stream. */
export function untarSingleFile(tar: Buffer): Buffer | null {
  if (tar.length < 512) return null;
  const sizeField = tar.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim();
  const size = Number.parseInt(sizeField, 8);
  if (!Number.isFinite(size) || 512 + size > tar.length) return null;
  return tar.subarray(512, 512 + size);
}

const SCAN_SEPARATOR = '@@agentbox-history-scan@@';

/** `find -printf '%s %p\n'` output → absolute path → size. */
export function parseSizeListing(text: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of text.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const n = Number.parseInt(line.slice(0, sp), 10);
    const p = line.slice(sp + 1);
    if (Number.isFinite(n) && p.startsWith('/')) sizes.set(p, n);
  }
  return sizes;
}

export interface DockerSourceOptions {
  container: string;
  run?: DockerRunner;
}

/** Label on every flush helper container, valued with the box's container name. */
export const HISTORY_HELPER_LABEL = 'agentbox.history-helper';

export interface DockerHistorySource extends HistoryFileSource {
  refreshState(): Promise<void>;
  isRunning(): boolean;
  /**
   * Stop every in-flight and future docker call, then remove any helper
   * container still holding the box's volumes. A destroy awaits this before
   * `docker volume rm`, which fails (silently) while a helper mounts them.
   */
  settle(): Promise<void>;
}

/** Remove helper containers left for `container` (e.g. by a crashed relay). */
export async function removeHistoryHelpers(
  container: string,
  run: DockerRunner = defaultRunner,
): Promise<void> {
  const ids = (await run(['ps', '-aq', '--filter', `label=${HISTORY_HELPER_LABEL}=${container}`]))
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (ids.length > 0) await run(['rm', '-f', ...ids]);
}

export function dockerHistorySource(opts: DockerSourceOptions): DockerHistorySource {
  const baseRun = opts.run ?? defaultRunner;
  const c = opts.container;
  const abort = new AbortController();
  const run: DockerRunner = (args) => {
    if (abort.signal.aborted) return Promise.reject(new Error('history source settled'));
    return baseRun(args, { signal: abort.signal });
  };
  let running = true;
  let image: string | null = null;

  const sh = async (script: string): Promise<Buffer> => {
    if (running) return run(['exec', '-u', 'vscode', c, 'sh', '-c', script]);
    image ??= (await run(['inspect', '-f', '{{.Config.Image}}', c])).toString('utf8').trim();
    return run([
      'run',
      '--rm',
      '--label',
      `${HISTORY_HELPER_LABEL}=${c}`,
      '--network',
      'none',
      '--volumes-from',
      c,
      '--entrypoint',
      'sh',
      image,
      '-c',
      script,
    ]);
  };

  const readBindings = async (): Promise<HistoryBinding[]> => {
    const path = `${BOX_HOME}/${HISTORY_BINDINGS_FILE}`;
    if (running) {
      const out = await sh(`cat ${shQuote(path)} 2>/dev/null || true`);
      return parseBindingLog(out.toString('utf8'));
    }
    try {
      const file = untarSingleFile(await run(['cp', `${c}:${path}`, '-']));
      return file ? parseBindingLog(file.toString('utf8')) : [];
    } catch {
      return [];
    }
  };

  return {
    isRunning: () => running,
    async settle() {
      abort.abort();
      // The aborted `docker run` client is gone but its container may not be.
      await removeHistoryHelpers(c, baseRun).catch(() => undefined);
    },
    async refreshState() {
      const status = (await run(['inspect', '-f', '{{.State.Status}}', c])).toString('utf8').trim();
      running = status === 'running';
    },
    readBindings,
    async size(path) {
      const out = (await sh(`stat -c %s ${shQuote(path)} 2>/dev/null || true`))
        .toString('utf8')
        .trim();
      const n = Number.parseInt(out, 10);
      return Number.isFinite(n) ? n : null;
    },
    async read(path, offset, length) {
      return sh(`tail -c +${String(offset + 1)} ${shQuote(path)} | head -c ${String(length)}`);
    },
    async scan(roots) {
      const path = `${BOX_HOME}/${HISTORY_BINDINGS_FILE}`;
      const finds = roots
        .map((r) => `find ${shQuote(r)} -maxdepth 5 -type f -printf '%s %p\\n' 2>/dev/null`)
        .join('; ');
      if (running) {
        // One exec: the log, a separator, then every file's size.
        const out = (
          await sh(
            `cat ${shQuote(path)} 2>/dev/null; printf '\\n${SCAN_SEPARATOR}\\n'; ${finds}; true`,
          )
        ).toString('utf8');
        const cut = out.indexOf(`\n${SCAN_SEPARATOR}\n`);
        const log = cut === -1 ? '' : out.slice(0, cut);
        const listing = cut === -1 ? out : out.slice(cut + SCAN_SEPARATOR.length + 2);
        return { bindings: parseBindingLog(log), sizes: parseSizeListing(listing) };
      }
      // Paused/stopped (a destroy's final flush): the log is on the writable
      // layer (docker cp), the transcripts on volumes (one helper container).
      const bindings = await readBindings();
      const sizes = parseSizeListing((await sh(`${finds}; true`)).toString('utf8'));
      return { bindings, sizes };
    },
    async list(dir) {
      const out = (await sh(`ls -1A ${shQuote(dir)} 2>/dev/null || true`)).toString('utf8');
      const names = out.split('\n').filter(Boolean);
      return names.length > 0 ? names : null;
    },
  };
}
