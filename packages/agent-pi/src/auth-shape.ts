/**
 * "Is this Pi `auth.json` a real login?" — one implementation, three callers.
 *
 * Pi writes a literal `{}` on first run, BEFORE any provider is added. That
 * makes existence and size useless as sign-in tests: every host that has ever
 * launched Pi looks authenticated. The consequences are silent in both
 * directions — the sign-in offer never appears, and an empty `{}` is staged
 * into the box as if it were a credential.
 *
 * Codex and OpenCode need no equivalent: neither writes an empty auth file, so
 * their `pathExists` checks are correct for them. This is Pi's own quirk, which
 * is why the helper lives in Pi's package rather than being pushed into the
 * shared credential concern.
 */

import { readFile } from 'node:fs/promises';

/** True when the file parses as JSON and holds at least one provider entry. */
export async function piAuthFileHasProviders(path: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}
