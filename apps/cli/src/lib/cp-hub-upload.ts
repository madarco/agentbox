import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { log } from '@clack/prompts';
import { readGitOriginUrl } from '@agentbox/sandbox-cloud';
import { projectSlugFromOriginUrl } from '@agentbox/sandbox-core';
import { captureCpCacheEntry, cpCachePrefix } from '@agentbox/relay';

/**
 * `agentbox cp <paths...> hub:` — put a file where your boxes can still read it
 * with this machine off.
 *
 * It writes the same custody entry a live `cp fromHost` leaves behind, under the
 * same project key, so this is not a parallel feature: pre-loading a dataset and
 * warming the cache are one operation, and a box asking for the same path later
 * cannot tell (or need to tell) which of the two put it there.
 *
 * Uploading is an explicit act by the person at the keyboard, so it needs no
 * approval — unlike a box *asking* for a file, which always does.
 */
export async function uploadToHubCache(hostSrcs: string[], projectRoot: string): Promise<void> {
  const { loadControlPlaneEnv } = await import('../control-plane/env-file.js');
  const { loadEffectiveConfig } = await import('@agentbox/config');
  loadControlPlaneEnv();
  const cfg = await loadEffectiveConfig(process.cwd());
  const url = (cfg.effective.relay.controlPlaneUrl ?? '').trim().replace(/\/+$/, '');
  const adminToken = process.env.AGENTBOX_RELAY_ADMIN_TOKEN ?? '';
  if (url.length === 0) {
    throw new Error(
      'no control box configured — `hub:` uploads to a remote hub. Set relay.controlPlaneUrl (or run `agentbox hub setup`).',
    );
  }
  if (adminToken.length === 0) {
    throw new Error(
      'no control-box admin token on this machine (run `agentbox hub setup`), so the upload cannot be authenticated.',
    );
  }

  // Key by project, matching what a box's own `cp fromHost` uses — otherwise the
  // upload lands somewhere the box will never look.
  const originUrl = await readGitOriginUrl(projectRoot).catch(() => undefined);
  const projectSlug = originUrl ? (projectSlugFromOriginUrl(originUrl) ?? undefined) : undefined;
  if (!projectSlug) {
    throw new Error(
      'this project has no git `origin` remote, so there is no project key to file the upload under. ' +
        'Add a remote, or copy the file into a box directly (`agentbox cp <file> <box>:<dest>`).',
    );
  }
  const prefix = cpCachePrefix({ projectSlug, boxId: '' });
  const maxBytes = cfg.effective.relay.custodyMaxBlobBytes;

  let stored = 0;
  for (const src of hostSrcs) {
    const abs = resolve(projectRoot, src);
    // Fail on a missing source rather than reporting "0 uploaded": a typo here
    // surfaces much later, as an unexplained cache miss inside a box.
    await stat(abs);
    const ok = await captureCpCacheEntry(abs, prefix, {
      controlPlaneUrl: url,
      adminToken,
      maxBytes,
      logger: (line) => log.info(line),
    });
    if (ok) {
      stored++;
      process.stdout.write(`uploaded ${abs} to the hub\n`);
    }
  }
  if (stored === 0) throw new Error('nothing was uploaded — see the messages above');
  process.stdout.write(
    'Boxes in this project can now read these paths with this machine offline;\n' +
      'they still ask for approval, and the copy is marked as cached.\n',
  );
}
