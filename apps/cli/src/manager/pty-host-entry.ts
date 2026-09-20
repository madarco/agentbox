/**
 * Entry point for a manager's pty-host: `node dist/pty-host.js --spec-fd 3`.
 *
 * Spawned detached by the hub, which then only talks to it over its unix
 * socket. It is a separate process — not a thread of the hub — for two reasons:
 * the hub restarts on every update and a manager must not die with it, and the
 * hub's standalone bundle ships no node_modules, so it can never `require`
 * node-pty itself.
 *
 * The spec arrives on fd 3 rather than argv because it carries the session
 * token and the agent's launch script, and argv is world-readable via `ps`.
 */
import { readFileSync } from 'node:fs';
import {
  PtyBackendUnavailable,
  PtyHostAlreadyRunning,
  startPtyHost,
  type PtyHostSpec,
} from '@agentbox/cli-kit';

const EXIT_ALREADY_RUNNING = 0;
const EXIT_BAD_SPEC = 2;
const EXIT_NO_BACKEND = 3;

function readSpec(argv: string[]): PtyHostSpec {
  const at = argv.indexOf('--spec-fd');
  const fd = at === -1 ? 3 : Number(argv[at + 1] ?? 3);
  return JSON.parse(readFileSync(fd, 'utf8')) as PtyHostSpec;
}

async function main(): Promise<void> {
  let spec: PtyHostSpec;
  try {
    spec = readSpec(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`pty-host: unreadable spec: ${(err as Error).message}\n`);
    process.exit(EXIT_BAD_SPEC);
  }

  let host;
  try {
    host = await startPtyHost(spec);
  } catch (err) {
    if (err instanceof PtyHostAlreadyRunning) {
      process.stderr.write(`pty-host: ${err.message}\n`);
      process.exit(EXIT_ALREADY_RUNNING);
    }
    if (err instanceof PtyBackendUnavailable) {
      process.stderr.write(`pty-host: ${err.message}\n`);
      process.exit(EXIT_NO_BACKEND);
    }
    process.stderr.write(`pty-host: ${(err as Error).message}\n`);
    process.exit(1);
  }

  process.stderr.write(`pty-host: listening on ${host.socketPath} (pid ${process.pid})\n`);
  // SIGHUP is what a terminating parent sends; the whole point of this process
  // is to outlive it, so only an explicit stop ends the session.
  process.on('SIGHUP', () => {});
  const code = await host.done;
  process.stderr.write(`pty-host: agent exited with ${code}\n`);
  process.exit(0);
}

void main();
