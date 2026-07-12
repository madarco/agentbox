/**
 * The host command that opens a URL or file path in the OS default handler.
 *
 * macOS ships `open`; Linux uses `xdg-open` (from `xdg-utils`, present on any
 * desktop install). We deliberately return only the binary name and let each
 * call site keep its own spawn semantics (sync/async, stdio, detached) — the
 * single platform decision lives here so adding a host platform is a one-line
 * change. Callers already treat a non-zero exit / ENOENT as "couldn't
 * auto-open" and print the target, so an absent `xdg-open` degrades cleanly.
 */
import { spawnSync } from 'node:child_process';

export function hostOpenCommand(): string {
  return process.platform === 'linux' ? 'xdg-open' : 'open';
}

/**
 * Put `text` on the host clipboard. Best-effort: returns false when the platform
 * has no clipboard tool (a headless Linux box, a BSD, a CI runner), and callers
 * fall back to printing the content for a manual copy.
 *
 * Used to hand a user a blob they must paste into a web console that has no
 * prefill parameter — e.g. the AWS IAM create-policy JSON tab. Text only; the
 * image-reading counterpart lives in `apps/cli/src/lib/host-clipboard.ts`, which
 * a provider package must not reach into.
 */
export function writeHostClipboardText(text: string): boolean {
  const tool = clipboardWriteTool();
  if (!tool) return false;
  try {
    const r = spawnSync(tool.cmd, tool.args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Which clipboard-write binary to use. Wayland wins over X11 when a Wayland
 * session is present. We only probe env vars here (not the binary itself) —
 * a missing binary surfaces as a spawn failure, which we already treat as
 * "no clipboard".
 */
function clipboardWriteTool(): { cmd: string; args: string[] } | null {
  if (process.platform === 'darwin') return { cmd: 'pbcopy', args: [] };
  if (process.platform === 'linux') {
    if (process.env['WAYLAND_DISPLAY']) return { cmd: 'wl-copy', args: [] };
    if (process.env['DISPLAY']) return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  }
  return null;
}
