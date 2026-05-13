import { ensureVolume, execInBox, type DockerExecResult } from './docker.js';

/**
 * Shared across all boxes. Holds downloaded extensions so the second box
 * onward doesn't re-download them. Never auto-removed by destroy/prune
 * (parallel to SHARED_CLAUDE_VOLUME).
 */
export const SHARED_VSCODE_EXTENSIONS_VOLUME = 'agentbox-vscode-extensions';

/** Per-box; holds the server binary + TS cache + workspace state. */
export function vscodeServerVolumeName(boxId: string): string {
  return `agentbox-vscode-server-${boxId}`;
}

export interface VscodeMounts {
  /** Volume names to ensure() before runBox. */
  volumes: string[];
  /** `-v` arg values to pass to runBox. */
  extraVolumes: string[];
}

/**
 * Build the volume mounts for VS Code Server inside a box. The per-box
 * `.vscode-server` volume mounts first, then the shared extensions volume
 * over its `extensions` subdir (Docker layers the deeper mount on top).
 */
export function buildVscodeMounts(boxId: string): VscodeMounts {
  const perBox = vscodeServerVolumeName(boxId);
  return {
    volumes: [perBox, SHARED_VSCODE_EXTENSIONS_VOLUME],
    extraVolumes: [
      `${perBox}:/home/vscode/.vscode-server`,
      `${SHARED_VSCODE_EXTENSIONS_VOLUME}:/home/vscode/.vscode-server/extensions`,
    ],
  };
}

export async function ensureVscodeVolumes(boxId: string): Promise<void> {
  const { volumes } = buildVscodeMounts(boxId);
  for (const v of volumes) await ensureVolume(v);
}

/**
 * VS Code's `vscode://vscode-remote/attached-container+<hex>/...` URL takes
 * the *container name* hex-encoded. This is what the Dev Containers extension
 * dispatches on.
 */
export function containerHex(containerName: string): string {
  return Buffer.from(containerName, 'utf8').toString('hex');
}

export function attachedContainerUri(containerName: string, workspacePath = '/workspace'): string {
  return `vscode://vscode-remote/attached-container+${containerHex(containerName)}${workspacePath}`;
}

/**
 * agentbox-managed `.vscode/tasks.json` lives in the overlay's upper layer so
 * it doesn't pollute the host's working tree. The sentinel comment lets us
 * detect our own file and regenerate it on every `agentbox code` invocation
 * without overwriting a user-authored one.
 */
const SENTINEL =
  '// agentbox-managed: regenerated on `agentbox code`; remove this header to take ownership';

export type ServiceTailHint = { name: string };

export interface EnsureTasksFileResult {
  status: 'wrote' | 'skipped-user-owned' | 'skipped-no-services';
}

/**
 * Write (or skip) `/workspace/.vscode/tasks.json` inside the container. Each
 * service in `services` gets a background task that tails its log so VS Code
 * shows a dedicated terminal panel on attach.
 *
 *  - File absent → write.
 *  - File present with our sentinel → overwrite.
 *  - File present without sentinel → skip (user owns it). Caller can force
 *    by setting `regen: true`.
 */
export async function ensureAgentboxTasksFile(
  container: string,
  services: ServiceTailHint[],
  opts: { regen?: boolean } = {},
): Promise<EnsureTasksFileResult> {
  if (services.length === 0) return { status: 'skipped-no-services' };

  // Probe the existing file. cat exits 0 if it exists; we only overwrite when
  // it's absent or our sentinel is present.
  const existing = await execInBox(container, ['cat', '/workspace/.vscode/tasks.json'], {
    user: 'vscode',
  });
  if (existing.exitCode === 0 && !opts.regen && !existing.stdout.includes(SENTINEL)) {
    return { status: 'skipped-user-owned' };
  }

  const tasks = services.map((s) => ({
    label: `agentbox: ${s.name}`,
    type: 'shell',
    command: `tail -F /var/log/agentbox/${s.name}.log`,
    isBackground: true,
    presentation: { panel: 'dedicated', reveal: 'always', echo: false },
    runOptions: { runOn: 'folderOpen' },
    problemMatcher: [] as unknown[],
  }));
  const body =
    `${SENTINEL}\n` +
    JSON.stringify(
      {
        version: '2.0.0',
        tasks,
      },
      null,
      2,
    ) +
    '\n';

  await execInBox(container, ['mkdir', '-p', '/workspace/.vscode'], { user: 'vscode' });
  const write = await writeFileInBox(container, '/workspace/.vscode/tasks.json', body);
  if (write.exitCode !== 0) {
    throw new Error(`failed to write tasks.json in ${container}: ${write.stderr || write.stdout}`);
  }
  return { status: 'wrote' };
}

/**
 * Write a file inside the container via `docker exec sh -c 'cat > path'`,
 * piping the content over stdin. Avoids shell-escaping the file body.
 */
async function writeFileInBox(
  container: string,
  path: string,
  content: string,
): Promise<DockerExecResult> {
  const { execa } = await import('execa');
  const result = await execa(
    'docker',
    ['exec', '-i', '--user', 'vscode', container, 'sh', '-c', `cat > ${shellQuote(path)}`],
    { input: content, reject: false },
  );
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
