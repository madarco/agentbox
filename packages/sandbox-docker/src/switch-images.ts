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
