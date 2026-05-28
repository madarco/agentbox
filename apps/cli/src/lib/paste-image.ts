/**
 * Host→box clipboard image paste, cross-provider.
 *
 * Wired into the attach wrapper's Ctrl+V hook (`wrapped-pty/run.ts`). When the
 * user pastes while attached to an in-box Claude Code session we:
 *   1. grab the image off the macOS clipboard (`captureClipboardImage`),
 *   2. make sure the box's X server (`DISPLAY=:1`) is up,
 *   3. ship the PNG into the box (`Provider.uploadPath`),
 *   4. load it into the box's X11 CLIPBOARD via `xclip -t image/png`.
 * The wrapper then forwards the literal Ctrl+V so Claude Code's own
 * "paste image from clipboard" binding reads the now-populated selection.
 *
 * All steps go through the provider-neutral `Provider` seam (`uploadPath` +
 * `exec`), so it works identically on docker / daytona / hetzner.
 */

import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BoxRecord, Provider } from '@agentbox/core';
import { captureClipboardImage } from './mac-clipboard.js';

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

export async function pasteHostClipboardImage(
  provider: Provider,
  box: BoxRecord,
): Promise<PasteImageResult> {
  if (typeof provider.uploadPath !== 'function') return 'error';

  const hostPng = await captureClipboardImage();
  if (!hostPng) return 'no-image';

  const boxPng = `/tmp/agentbox-clip-${String(Date.now())}.png`;
  try {
    await provider.uploadPath(box, hostPng, boxPng);
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
