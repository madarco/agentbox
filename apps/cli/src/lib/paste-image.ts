/**
 * Host→box clipboard image paste, cross-provider.
 *
 * Wired into the attach wrapper's Ctrl+V hook (`wrapped-pty/run.ts`). When the
 * user pastes while attached to an in-box Claude Code session we:
 *   1. grab the image off the host clipboard (`captureClipboardImage`),
 *   2. make sure the box's X server (`DISPLAY=:1`) is up,
 *   3. ship the PNG into the box (`Provider.uploadPath`),
 *   4. load it into the box's X11 CLIPBOARD via `xclip -t image/png`.
 * The wrapper then forwards the literal Ctrl+V so Claude Code's own
 * "paste image from clipboard" binding reads the now-populated selection.
 *
 * All steps go through the provider-neutral `Provider` seam (`uploadPath` +
 * `exec`), so it works identically on docker / daytona / hetzner / vercel.
 */

import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BoxRecord, Provider } from '@agentbox/core';
import { captureClipboardImage } from './host-clipboard.js';

export type PasteImageResult = 'pasted' | 'no-image' | 'error';

/** Box-side load: ensure Xvnc is up, wait for the X socket, then hand the PNG
 *  to a detached `xclip` that keeps owning the CLIPBOARD selection until Claude
 *  reads it. `setsid … &` so it survives `exec` returning. The path is a
 *  CLI-generated `/tmp` name (no shell metacharacters), so inlining is safe. */
function loadClipboardScript(boxPngPath: string): string {
  return [
    'pgrep -x Xvnc >/dev/null 2>&1 || /usr/local/bin/agentbox-vnc-start >/dev/null 2>&1 || true',
    'for _ in $(seq 1 30); do [ -S /tmp/.X11-unix/X1 ] && break; sleep 0.2; done',
    `setsid sh -c 'DISPLAY=:1 xclip -selection clipboard -t image/png -i ${boxPngPath}' </dev/null >/dev/null 2>&1 &`,
  ].join('; ');
}

/**
 * Upload a host image file into the box and return its box-side path (or null on
 * failure). Used for the Herdr paste path: Herdr turns a clipboard screenshot
 * into a *host* file and pastes its path, which a boxed Claude can't read — so we
 * ship that file into the box and substitute the box path, which Claude Code then
 * attaches as an image (`[Image #1]`). No clipboard/X11 needed (unlike the Ctrl+V
 * path above): Claude reads the pasted path directly.
 */
export async function uploadImageFileToBox(
  provider: Provider,
  box: BoxRecord,
  hostPath: string,
): Promise<string | null> {
  if (typeof provider.uploadPath !== 'function') return null;
  const boxPng = `/tmp/agentbox-clip-${String(Date.now())}.png`;
  try {
    await provider.uploadPath(box, [hostPath], boxPng);
    return boxPng;
  } catch {
    return null;
  }
}

export async function pasteHostClipboardImage(
  provider: Provider,
  box: BoxRecord,
): Promise<PasteImageResult> {
  if (typeof provider.uploadPath !== 'function') return 'error';

  const hostPng = await captureClipboardImage();
  if (!hostPng) return 'no-image';

  const boxPng = `/tmp/agentbox-clip-${String(Date.now())}.png`;
  try {
    await provider.uploadPath(box, [hostPng], boxPng);
    await provider.exec(box, ['sh', '-lc', loadClipboardScript(boxPng)], {
      user: 'vscode',
    });
    return 'pasted';
  } catch {
    return 'error';
  } finally {
    await rm(dirname(hostPng), { recursive: true, force: true }).catch(() => {});
  }
}
