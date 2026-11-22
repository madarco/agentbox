import { execa } from 'execa';
import { HISTORY_BINDINGS_FILE, parseBindingLog, type HistoryFileSource } from '@agentbox/core';

/**
 * Reads a docker box's agent files from the host. A running box is read with
 * `docker exec`; a paused or stopped one (a destroy's final flush) through a
 * throwaway container that mounts the box's volumes (`--volumes-from`), plus
 * `docker cp` for the binding log, which lives on the box's own writable layer.
 */

const BOX_HOME = '/home/vscode';
const EXEC_TIMEOUT_MS = 60_000;

export type DockerRunner = (args: string[], input?: string) => Promise<Buffer>;

const defaultRunner: DockerRunner = async (args) => {
  const r = await execa('docker', args, {
    encoding: 'buffer',
    timeout: EXEC_TIMEOUT_MS,
    reject: false,
    stripFinalNewline: false,
  });
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

export interface DockerSourceOptions {
  container: string;
  run?: DockerRunner;
}

export function dockerHistorySource(opts: DockerSourceOptions): HistoryFileSource & {
  refreshState(): Promise<void>;
} {
  const run = opts.run ?? defaultRunner;
  const c = opts.container;
  let running = true;
  let image: string | null = null;

  const sh = async (script: string): Promise<Buffer> => {
    if (running) return run(['exec', '-u', 'vscode', c, 'sh', '-c', script]);
    image ??= (await run(['inspect', '-f', '{{.Config.Image}}', c])).toString('utf8').trim();
    return run([
      'run',
      '--rm',
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

  return {
    async refreshState() {
      const status = (await run(['inspect', '-f', '{{.State.Status}}', c])).toString('utf8').trim();
      running = status === 'running';
    },
    async readBindings() {
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
    },
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
    async list(dir) {
      const out = (await sh(`ls -1A ${shQuote(dir)} 2>/dev/null || true`)).toString('utf8');
      const names = out.split('\n').filter(Boolean);
      return names.length > 0 ? names : null;
    },
  };
}
