/**
 * Shared types/errors for the session-teleport module. Kept separate so the
 * per-agent files (`claude.ts` / `codex.ts` / `opencode.ts`) don't form an
 * import cycle through `index.ts`.
 */

export type TeleportAgent = 'claude' | 'codex' | 'opencode';

export type TeleportLogger = (line: string) => void;

/**
 * Caller-supplied "what resume mode is this" struct. Mirrors the user-facing
 * flag set:
 *   - `{ kind: 'continue' }` for `-c` / `--continue` (newest session for cwd)
 *   - `{ kind: 'resume', id }` for `--resume <id>` (specific session)
 */
export type ResumeMode =
  | { kind: 'continue' }
  | { kind: 'resume'; id: string };

export interface ResolvedTeleport {
  agent: TeleportAgent;
  /** The session id we resolved (uuid). */
  sessionId: string;
  /**
   * Host-side path to the rewritten session file ready for upload. Lives in a
   * tmp dir under `os.tmpdir()` — the caller does not need to clean it up;
   * normal tmp cleanup applies.
   */
  hostFile: string;
  /** Absolute in-box destination path including filename. */
  boxPath: string;
  /** Absolute in-box destination directory — useful for `mkdir -p` before upload. */
  boxParentDir: string;
  /**
   * Canonical argv tokens to prepend to the agent's argv inside the box, e.g.
   * `['--resume', '<uuid>']` for claude or `['resume', '<uuid>']` for codex.
   */
  forwardArgs: string[];
}

export class TeleportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeleportError';
  }
}
