import { execa } from 'execa';
import { removeImage } from './docker.js';

/** Label on the images an account switch commits (hub settings 3c). */
export const SWITCH_IMAGE_LABEL = 'agentbox.switch.box';
export const SWITCH_IMAGE_REPO = 'agentbox-switch';

/** Remove the images earlier switches of `boxId` left, except `keep`. Best-effort. */
export async function removeSwitchImages(boxId: string, keep?: string): Promise<void> {
  const r = await execa(
    'docker',
    [
      'images',
      '--filter',
      `label=${SWITCH_IMAGE_LABEL}=${boxId}`,
      // A checkpoint committed from a switched box inherits the label; only
      // the switch's own repository is ours to remove.
      '--filter',
      `reference=${SWITCH_IMAGE_REPO}:*`,
      '--format',
      '{{.Repository}}:{{.Tag}}',
    ],
    { reject: false },
  );
  for (const ref of r.stdout.split('\n').map((l) => l.trim())) {
    if (ref && ref !== keep) await removeImage(ref, { force: false }).catch(() => false);
  }
}

/** The infix of the name a switch parks the old container under. */
export const PARKED_INFIX = '-pre-switch-';

/** Names of the containers earlier switches of `container` parked, newest first. */
async function parkedContainers(container: string): Promise<string[]> {
  const r = await execa(
    'docker',
    ['ps', '-a', '--filter', `name=^/${container}${PARKED_INFIX}`, '--format', '{{.Names}}'],
    { reject: false },
  );
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((n) => n.startsWith(`${container}${PARKED_INFIX}`))
    .sort()
    .reverse();
}

/**
 * Tidy what an interrupted switch left (hub settings 3c). When the box's
 * container is gone but a parked one exists (a crash between parking and
 * creating), the newest parked one becomes the box again; every other parked
 * container is removed unless `removeOthers` is false (a start, which may run
 * inside a switch that still needs its parked container). Best-effort.
 */
export async function recoverParkedContainers(
  container: string,
  opts: { removeOthers?: boolean } = {},
): Promise<void> {
  const parked = await parkedContainers(container);
  if (parked.length === 0) return;
  const exists =
    (await execa('docker', ['container', 'inspect', container], { reject: false })).exitCode === 0;
  let rest = parked;
  if (!exists) {
    const [newest, ...older] = parked;
    await execa('docker', ['rename', newest!, container], { reject: false });
    rest = older;
  }
  if (opts.removeOthers === false) return;
  for (const name of rest) await execa('docker', ['rm', '-f', name], { reject: false });
}

/** Remove every container a switch parked for `container`. Best-effort. */
export async function removeParkedContainers(container: string): Promise<void> {
  for (const name of await parkedContainers(container)) {
    await execa('docker', ['rm', '-f', name], { reject: false });
  }
}
