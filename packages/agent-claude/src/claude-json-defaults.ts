/**
 * The in-box `_claude.json` a box gets when the host has no `~/.claude.json` to
 * start from. Every provider writes this one object: docker into the config
 * volume (`ensureClaudeVolume`), the cloud-shaped providers through the staged
 * overlay (`host-stage.ts`), so the two cannot drift.
 *
 * `hasCompletedOnboarding` is what keeps claude off its first-run theme picker,
 * which would otherwise swallow an `-i` turn. `installMethod: native` skips the
 * install-integrity warning, and a trusted workspace skips the trust dialog (an
 * untrusted one also yields `400 role 'system' is not supported`).
 */
export function defaultBoxClaudeJson(workspace: string): Record<string, unknown> {
  return {
    installMethod: 'native',
    autoUpdates: false,
    autoUpdatesProtectedForNative: true,
    hasCompletedOnboarding: true,
    projects: { [workspace]: { hasTrustDialogAccepted: true } },
  };
}
