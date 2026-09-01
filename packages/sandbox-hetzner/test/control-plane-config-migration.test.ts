import { describe, expect, it } from 'vitest';
import { buildControlPlaneConfigYaml } from '../src/control-plane-deploy.js';

/**
 * `claude.install` selects how `prepare` installs Claude Code, and it lives in
 * the PC's `config.yaml` — a different file from `secrets.env`, so the deploy's
 * provider-secret allowlist never carried it. The control box therefore fell back
 * to the built-in `native` and baked the mode most likely to 403 there.
 *
 * The set of migrated keys is DERIVED (every bake-affecting agent setting that
 * is not at its default), so a future agent's bake setting migrates with no edit
 * to the deploy — these tests drive the merge with an arbitrary key to pin that.
 *
 * The migration must MERGE: the hub writes this same file itself
 * (`box.remoteDockerHost` from Settings), so a regenerated file would drop the
 * control box's own keys on each redeploy.
 */
describe('buildControlPlaneConfigYaml', () => {
  it('returns null when there is nothing to migrate', () => {
    expect(buildControlPlaneConfigYaml('', {})).toBeNull();
    // An undefined value means "at the default" — not something to write.
    expect(buildControlPlaneConfigYaml('', { 'claude.install': undefined })).toBeNull();
  });

  it('writes the key into a VPS that has no config yet', () => {
    const out = buildControlPlaneConfigYaml('', { 'claude.install': 'npm' });
    expect(out).toContain('install: npm');
  });

  it("keeps the hub's own keys on a redeploy", () => {
    const remote = 'schema: 1\nbox:\n  remoteDockerHost: my-server\n';
    const out = buildControlPlaneConfigYaml(remote, { 'claude.install': 'npm' });
    expect(out).toContain('remoteDockerHost: my-server');
    expect(out).toContain('install: npm');
  });

  it('handles a body with no trailing newline', () => {
    // The deploy reads the remote file via `sshExec`, and execa strips the final
    // newline — so the body handed to the merge legitimately lacks one.
    const out = buildControlPlaneConfigYaml('box:\n  remoteDockerHost: srv\nschema: 1', {
      'claude.install': 'npm',
    });
    expect(out).toContain('remoteDockerHost: srv');
    expect(out).toContain('install: npm');
  });

  it('overwrites a previously migrated value instead of appending', () => {
    const remote = 'schema: 1\nclaude:\n  install: npm\n';
    const out = buildControlPlaneConfigYaml(remote, { 'claude.install': 'native' });
    expect(out).toContain('install: native');
    expect(out?.match(/install:/g)).toHaveLength(1);
  });
});
