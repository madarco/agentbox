/**
 * A one-slot hook the cloud create path uses to refresh the host-side agent
 * credential backups (`~/.agentbox/{claude,codex,opencode}-credentials.json`)
 * from the live docker shared volumes before it seeds a cloud box from them.
 *
 * Why a hook: the refresh is a docker `docker run` against the shared credential
 * volumes, so it belongs in `@agentbox/sandbox-docker`. `@agentbox/sandbox-cloud`
 * must not reach into docker (a docker-free host that only builds cloud boxes
 * would otherwise import docker machinery, and the reach-in would fail there).
 * So the CLI installs the docker refresher at startup and the cloud seed path
 * calls {@link runDockerCredentialRefresh}; with no hook installed it is a no-op
 * and the seed uses whatever backup already exists.
 *
 * Best-effort, exactly like the reach-in it replaces: every underlying docker
 * helper already swallows its own failures, and this never throws.
 */

/** Refreshes the host credential backups from the docker shared volumes. */
export type DockerCredentialRefresher = (opts: { onLog?: (line: string) => void }) => Promise<void>;

let activeRefresher: DockerCredentialRefresher | undefined;

/** Install (or clear, with `undefined`) the refresher. The CLI calls this once. */
export function setDockerCredentialRefresh(fn: DockerCredentialRefresher | undefined): void {
  activeRefresher = fn;
}

/**
 * Refresh the host credential backups from docker, if a refresher is installed.
 * No-op (and never throws) when none is — the cloud seed proceeds against the
 * existing backup.
 */
export async function runDockerCredentialRefresh(opts: {
  onLog?: (line: string) => void;
}): Promise<void> {
  if (!activeRefresher) return;
  try {
    await activeRefresher(opts);
  } catch {
    /* best-effort — the refresher swallows its own failures */
  }
}
