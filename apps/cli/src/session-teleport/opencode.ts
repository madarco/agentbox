/**
 * OpenCode session teleport — v1 stub. OpenCode stores sessions in a
 * multi-tenant SQLite DB at `~/.local/share/opencode/opencode.db` with sibling
 * `storage/`, `snapshot/`, `repos/` directories. A naive teleport would copy
 * the entire DB (leaking every other project's sessions into the sandbox), and
 * row-level extraction is real work (foreign keys, FTS indices, snapshot
 * artifacts on disk that live outside the DB).
 *
 * Tracked for v2; for v1 we fail fast with a clear message.
 */

import { TeleportError } from './types.js';

export function resolveOpencodeTeleport(): never {
  throw new TeleportError(
    'OpenCode session teleport is not yet supported in agentbox (sessions live in a multi-tenant SQLite DB at ~/.local/share/opencode/opencode.db; per-project extraction is tracked for a follow-up). Run `agentbox opencode` without -c / --resume to start a fresh session, or open an issue if you need this feature.',
  );
}
