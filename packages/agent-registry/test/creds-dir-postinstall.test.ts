import { describe, expect, it } from 'vitest';
import { BOX_CREDS_DIR, resolveAgentInstall } from '@agentbox/core';
import { BUILTIN_AGENT_SPECS } from '../src/index.js';

/**
 * `BOX_CREDS_DIR` is a MOUNT at runtime, not a directory the recipe owns.
 *
 * On Daytona it is virtiofs: `drwxrwxrwx root root`, and `chown`/`chmod` there
 * return EPERM even for root (verified live 2026-09-01 against a mounted
 * `agentbox-credentials` volume). A recipe that insists on owning it works at
 * bake time — when nothing is mounted yet — and fails every runtime install,
 * which is how a codex box on Daytona died with
 * `cannot change owner and permissions of '/home/vscode/.agentbox-creds/codex'`.
 *
 * Every agent's recipe, including a plugin's, must therefore create that subdir
 * without asserting ownership of it.
 */
function postInstalls(): { id: string; script: string }[] {
  const out: { id: string; script: string }[] = [];
  for (const spec of BUILTIN_AGENT_SPECS) {
    for (const settings of [
      undefined,
      ...Object.keys(spec.install.alternates ?? {}).map((k) => ({
        [spec.install.alternatesFrom ?? '']: k,
      })),
    ]) {
      const install = resolveAgentInstall(spec.install, settings);
      if (install.postInstall) out.push({ id: spec.id, script: install.postInstall });
    }
  }
  return out;
}

describe('agent post-install vs the credentials mount', () => {
  it('covers every shipped recipe, including the alternates', () => {
    const ids = postInstalls().map((p) => p.id);
    expect(new Set(ids)).toEqual(new Set(['claude', 'codex', 'opencode', 'example']));
    // claude declares an `npm` alternate with its own postInstall.
    expect(ids.filter((id) => id === 'claude').length).toBeGreaterThan(1);
  });

  it('never chmods or chowns the mount as a hard step', () => {
    for (const { id, script } of postInstalls()) {
      // `install -d` chowns AND chmods what it creates — fatal on the mount.
      expect(script, id).not.toMatch(
        new RegExp(`install -d[^&|]*${BOX_CREDS_DIR.replaceAll('.', '\\.')}`),
      );
      // A plain `chown -R` on it aborts the `&&` chain the same way. The steps
      // are `&&`-joined, so a step is everything up to the next `&&`.
      for (const step of script.split('&&')) {
        if (!step.includes('chown') || !step.includes(BOX_CREDS_DIR)) continue;
        expect(step, `${id}: chown of the creds mount must be best-effort`).toContain('|| true');
      }
    }
  });

  it('still creates the agent subdir of the mount', () => {
    for (const { id, script } of postInstalls()) {
      expect(script, id).toContain(`mkdir -p ${BOX_CREDS_DIR}/`);
    }
  });
});
