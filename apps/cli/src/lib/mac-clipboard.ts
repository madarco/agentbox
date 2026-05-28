/**
 * Capture an image off the macOS clipboard to a host temp PNG.
 *
 * Used by the Ctrl+V paste path (`paste-image.ts`): when the user pastes while
 * attached to an in-box Claude Code session, we grab whatever image they copied
 * on the host and ship it into the box. macOS only — `captureClipboardImage`
 * returns `null` on every other platform so the caller cleanly forwards Ctrl+V
 * unchanged.
 *
 * No new deps: `osascript` coerces the clipboard to PNG, and `sips` (also a
 * macOS built-in) converts a screenshot TIFF when the PNG coercion isn't
 * available. Both ship with the OS.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

/**
 * AppleScript that tries to write the clipboard to `<path>` as PNG, falling
 * back to TIFF. Prints `PNG`, `TIFF`, or `NONE` so the caller knows what (if
 * anything) landed and whether it still needs converting.
 */
function captureScriptArgs(pngPath: string, tiffPath: string): string[] {
  return [
    'try',
    '  set theData to (the clipboard as «class PNGf»)',
    `  set fh to open for access (POSIX file ${JSON.stringify(pngPath)}) with write permission`,
    '  set eof fh to 0',
    '  write theData to fh',
    '  close access fh',
    '  return "PNG"',
    'on error',
    '  try',
    '    set theData to (the clipboard as «class TIFF»)',
    `    set fh to open for access (POSIX file ${JSON.stringify(tiffPath)}) with write permission`,
    '    set eof fh to 0',
    '    write theData to fh',
    '    close access fh',
    '    return "TIFF"',
    '  on error',
    '    return "NONE"',
    '  end try',
    'end try',
  ]
    .map((line) => ['-e', line])
    .flat();
}

/**
 * Grab the current clipboard image into a host temp PNG. Returns the file path,
 * or `null` when the clipboard holds no image (or we're not on macOS, or the
 * capture failed). The caller owns the returned file and should delete it after
 * delivery.
 */
export async function captureClipboardImage(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;

  const dir = await mkdtemp(join(tmpdir(), 'agentbox-clip-'));
  const pngPath = join(dir, 'clip.png');
  const tiffPath = join(dir, 'clip.tiff');

  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  const res = await execa('osascript', captureScriptArgs(pngPath, tiffPath), {
    reject: false,
  });
  const kind = res.stdout.trim();

  if (kind === 'PNG') {
    if (await fileHasBytes(pngPath)) return pngPath;
    await cleanup();
    return null;
  }

  if (kind === 'TIFF' && (await fileHasBytes(tiffPath))) {
    // Screenshots land on the clipboard as TIFF; convert to PNG with sips.
    const conv = await execa(
      'sips',
      ['-s', 'format', 'png', tiffPath, '--out', pngPath],
      { reject: false },
    );
    if (conv.exitCode === 0 && (await fileHasBytes(pngPath))) return pngPath;
  }

  await cleanup();
  return null;
}

async function fileHasBytes(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}
