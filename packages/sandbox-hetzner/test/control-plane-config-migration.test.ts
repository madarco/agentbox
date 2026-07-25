import { describe, expect, it } from 'vitest';
import { buildControlPlaneConfigYaml } from '../src/control-plane-deploy.js';

/**
 * `box.claudeInstall` selects how `prepare` installs Claude Code, and it lives in
 * the PC's `config.yaml` — a different file from `secrets.env`, so the deploy's
 * provider-secret allowlist never carried it. The control box therefore fell back
 * to the built-in `native`, its fingerprint never matched an `npm`-baked shared
 * record, and every cloud create failed with "run `agentbox prepare` first".
 *
 * The migration must MERGE: the hub writes this same file itself
 * (`box.remoteDockerHost` from Settings), so a regenerated file would drop the
 * control box's own keys on each redeploy.
 */
describe('buildControlPlaneConfigYaml', () => {
  it('returns null when there is nothing to migrate', () => {
    expect(buildControlPlaneConfigYaml('', {})).toBeNull();
    // An undefined value means "at the default" — not something to write.
    expect(buildControlPlaneConfigYaml('', { 'box.claudeInstall': undefined })).toBeNull();
  });

  it('writes the key into a VPS that has no config yet', () => {
    const out = buildControlPlaneConfigYaml('', { 'box.claudeInstall': 'npm' });
    expect(out).toContain('claudeInstall: npm');
  });

  it("keeps the hub's own keys on a redeploy", () => {
    const remote = 'schema: 1\nbox:\n  remoteDockerHost: my-server\n';
    const out = buildControlPlaneConfigYaml(remote, { 'box.claudeInstall': 'npm' });
    expect(out).toContain('remoteDockerHost: my-server');
    expect(out).toContain('claudeInstall: npm');
  });

  it('overwrites a previously migrated value instead of appending', () => {
    const remote = 'schema: 1\nbox:\n  claudeInstall: npm\n';
    const out = buildControlPlaneConfigYaml(remote, { 'box.claudeInstall': 'native' });
    expect(out).toContain('claudeInstall: native');
    expect(out?.match(/claudeInstall/g)).toHaveLength(1);
  });
});
