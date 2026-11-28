/**
 * A docker box's own global git config.
 *
 * The building machine's `~/.gitconfig` is bind-mounted read-only at
 * `/home/vscode/.gitconfig`, and git ranks the global file above `--system`, so
 * nothing written inside the box could outrank an identity it holds: a box a
 * hub built for someone else would commit as the hub's owner. Every box
 * therefore points `GIT_CONFIG_GLOBAL` at a file the box owns, which first
 * includes the mounted one (so its credential helpers, aliases and the rest
 * still apply) and then, when needed, sets `[user]`. Later entries win, so that
 * `[user]` beats the mounted file's, and a repo-local identity still beats both.
 */

/** In-box path of the box-owned global config (`GIT_CONFIG_GLOBAL`). */
export const BOX_GITCONFIG_PATH = '/home/vscode/.config/agentbox/gitconfig';
/** Where the building machine's `~/.gitconfig` is bind-mounted, read-only. */
export const MOUNTED_GITCONFIG_PATH = '/home/vscode/.gitconfig';

/**
 * `sh -c` script + positional args that rewrite `file` from scratch: an include
 * of `includePath`, then `[user]` when `identity` is given. Rewritten on every
 * create, so a file a checkpoint carried never keeps a previous owner's
 * identity. Values go through `git config`, which quotes them.
 */
export function boxGitConfigScript(
  identity: { name: string; email: string } | undefined,
  file = BOX_GITCONFIG_PATH,
  includePath = MOUNTED_GITCONFIG_PATH,
): { script: string; args: string[] } {
  const lines = [
    'set -e',
    'f="$1"',
    'mkdir -p "$(dirname "$f")"',
    'rm -f "$f"',
    'git config --file "$f" include.path "$2"',
  ];
  if (identity) {
    lines.push('git config --file "$f" user.name "$3"', 'git config --file "$f" user.email "$4"');
  }
  return {
    script: lines.join('\n'),
    args: [file, includePath, ...(identity ? [identity.name, identity.email] : [])],
  };
}
