/**
 * Capture an image off the host clipboard to a temp PNG.
 *
 * Used by the Ctrl+V paste path (`paste-image.ts`): when the user pastes while
 * attached to an in-box Claude Code session, we grab whatever image they copied
 * on the host and ship it into the box. Supported hosts:
 *   - macOS: `osascript` coerces the clipboard to PNG (TIFF screenshots are
 *     converted with `sips`). Both ship with the OS.
 *   - Linux (X11 / Wayland desktop): `xclip` / `wl-paste` read the `image/png`
 *     clipboard target. These aren't always installed, so capture degrades to
 *     `null` when the tool (or a display) is missing.
 * Every other platform returns `null`, so the caller cleanly forwards Ctrl+V
 * unchanged.
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

/**
 * Grab the current clipboard image into a host temp PNG. Returns the file path,
 * or `null` when the clipboard holds no image (unsupported platform, missing
 * tool, or capture failed). The caller owns the returned file and should delete
 * it (and its parent dir) after delivery.
 */
export async function captureClipboardImage(): Promise<string | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;

  const dir = await mkdtemp(join(tmpdir(), 'agentbox-clip-'));
  const pngPath = join(dir, 'clip.png');
  const ok =
    process.platform === 'darwin'
      ? await captureDarwin(dir, pngPath)
      : await captureLinux(pngPath);

  if (ok) return pngPath;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return null;
}

/**
 * True when this host has a clipboard-image capture path. Call sites use it to
 * decide whether to wire the Ctrl+V hook at all — so a host with no clipboard
 * tool (or no display) leaves Ctrl+V forwarding verbatim instead of
 * intercepting it for a guaranteed-empty paste.
 */
export async function clipboardCaptureAvailable(): Promise<boolean> {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'linux') return (await linuxClipboardTool()) !== null;
  return false;
}

// ---- macOS ----

/** AppleScript that writes the clipboard to `<path>` as PNG, falling back to
 *  TIFF. Prints `PNG`, `TIFF`, or `NONE`. Returns the flattened `-e <line> …`
 *  argv for `osascript`. */
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

async function captureDarwin(dir: string, pngPath: string): Promise<boolean> {
  const tiffPath = join(dir, 'clip.tiff');
  const res = await execa('osascript', captureScriptArgs(pngPath, tiffPath), {
    reject: false,
  });
  const kind = res.stdout.trim();

  if (kind === 'PNG') return fileHasBytes(pngPath);

  if (kind === 'TIFF' && (await fileHasBytes(tiffPath))) {
    // Screenshots land on the clipboard as TIFF; convert to PNG with sips.
    const conv = await execa(
      'sips',
      ['-s', 'format', 'png', tiffPath, '--out', pngPath],
      { reject: false },
    );
    if (conv.exitCode === 0) return fileHasBytes(pngPath);
  }
  return false;
}

// ---- Linux (X11 / Wayland) ----

/** Which clipboard tool to use on this Linux host, or `null` when none is
 *  usable (no display, or the binary isn't installed). Wayland wins when a
 *  Wayland session is present. */
async function linuxClipboardTool(): Promise<'wayland' | 'x11' | null> {
  if (process.env['WAYLAND_DISPLAY'] && (await hasCmd('wl-paste'))) return 'wayland';
  if (process.env['DISPLAY'] && (await hasCmd('xclip'))) return 'x11';
  return null;
}

async function captureLinux(pngPath: string): Promise<boolean> {
  const tool = await linuxClipboardTool();
  if (!tool) return false;

  let buf: Buffer | null = null;
  if (tool === 'wayland') {
    const types = await execa('wl-paste', ['--list-types'], { reject: false });
    if (types.exitCode !== 0 || !/image\/png/i.test(types.stdout)) return false;
    const r = await execa('wl-paste', ['--type', 'image/png'], {
      encoding: 'buffer',
      reject: false,
    });
    if (r.exitCode === 0) buf = asBuffer(r.stdout);
  } else {
    const sel = ['-selection', 'clipboard'];
    const targets = await execa('xclip', [...sel, '-t', 'TARGETS', '-o'], {
      reject: false,
    });
    if (targets.exitCode !== 0 || !/image\/png/i.test(targets.stdout)) return false;
    const r = await execa('xclip', [...sel, '-t', 'image/png', '-o'], {
      encoding: 'buffer',
      reject: false,
    });
    if (r.exitCode === 0) buf = asBuffer(r.stdout);
  }

  if (!buf || !isPng(buf)) return false;
  await writeFile(pngPath, buf);
  return true;
}

// ---- helpers ----

/** `command -v <cmd>` — true when the binary is on PATH. `cmd` is a fixed
 *  literal at every call site (no injection surface). */
async function hasCmd(cmd: string): Promise<boolean> {
  const r = await execa('sh', ['-c', `command -v ${cmd}`], { reject: false });
  return r.exitCode === 0;
}

function asBuffer(out: unknown): Buffer | null {
  if (Buffer.isBuffer(out)) return out;
  if (out instanceof Uint8Array) return Buffer.from(out);
  return null;
}

function isPng(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

async function fileHasBytes(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}
