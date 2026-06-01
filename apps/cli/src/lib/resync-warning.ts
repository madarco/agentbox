import type { ResyncResult } from '@agentbox/core';

/** Strip the leading `/workspace` / `/workspace/<sub>` so paths read repo-relative. */
function repoRelative(containerPath: string, file: string): string {
  const base = containerPath.replace(/^\/workspace\/?/, '');
  return base ? `${base}/${file}` : file;
}

/**
 * Build the conflict-warning turn injected into the agent's prompt after a
 * resync skipped host changes to keep the box's version. Returns null when the
 * resync had no conflicts (nothing to warn about).
 */
export function buildResyncWarning(r: ResyncResult): string | null {
  if (!r.hadConflicts) return null;
  const files: string[] = [];
  for (const repo of r.repos) {
    for (const f of repo.mergeConflicts) files.push(repoRelative(repo.containerPath, f));
    for (const f of repo.overlaySkipped) files.push(repoRelative(repo.containerPath, f));
  }
  const unique = [...new Set(files)];
  if (unique.length === 0) return null;
  return (
    "[agentbox] I synced this box with the host's latest workspace (new commits + the " +
    "host's uncommitted/untracked changes). These files had conflicting host changes that " +
    "I SKIPPED to keep your box's version — review them if the host edits matter:\n" +
    unique.map((f) => `  - ${f}`).join('\n')
  );
}

/** Prepend the warning (if any) to an existing seed prompt; null stays null. */
export function prependResyncWarning(warning: string | null, prompt: string): string {
  if (!warning) return prompt;
  return prompt.length > 0 ? `${warning}\n\n${prompt}` : warning;
}
