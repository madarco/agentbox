import { describe, expect, it, vi } from 'vitest';

// `GLOBAL_CONFIG_FILE` is a module-level constant computed from `homedir()` at
// import time, so redirecting $HOME in-process does nothing. Mock the config
// module instead — this file is separate so the mock can't leak into the other
// install tests.
vi.mock('@agentbox/config', () => ({
  loadEffectiveConfig: async () => ({ effective: { box: { claudeInstall: 'npm' } } }),
}));

const { makeRecordingTransport } = await import('../src/sync/recording-transport.js');
const { ensureAgentInstalled } = await import('../src/sync/concerns/install.js');

/** Probe misses once, everything after succeeds — the "needs installing" path. */
function missingThenOk() {
  let firstProbe = true;
  return (cmd: string[]) => {
    if (cmd.join(' ').includes('command -v')) {
      if (firstProbe) {
        firstProbe = false;
        return { exitCode: 1, stdout: '', stderr: 'not found' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('ensureAgentInstalled — install mode defaults from config', () => {
  it("uses claude's npm recipe when box.claudeInstall is npm and no mode is passed", async () => {
    // The runtime callers (claude start, the dashboard agent switch, the cloud
    // attach paths) thread no mode. Without this default, a host that set npm
    // BECAUSE the native CDN 403s would hit that CDN anyway when adding claude
    // to an existing box — a fresh box would work and an existing one wouldn't.
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    await ensureAgentInstalled(t, 'claude');
    const cmds = t.ops
      .filter((o) => o.op === 'exec')
      .map((o) => (o.args.cmd as string[]).join(' '));
    expect(cmds.some((c) => c.includes('npm install -g @anthropic-ai/claude-code'))).toBe(true);
    expect(cmds.some((c) => c.includes('claude.ai/install.sh'))).toBe(false);
  });

  it('an explicit mode still wins over the config', async () => {
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    await ensureAgentInstalled(t, 'claude', { installMode: 'native' });
    const cmds = t.ops
      .filter((o) => o.op === 'exec')
      .map((o) => (o.args.cmd as string[]).join(' '));
    expect(cmds.some((c) => c.includes('claude.ai/install.sh'))).toBe(true);
  });
});

describe('both claude recipes seed the first-run wizard skill', () => {
  // The `/agentbox-setup` skill moved off the providers' base scripts and onto
  // claude's install recipe. It first landed only on the NATIVE one, which
  // silently cost `box.claudeInstall: npm` — the CDN-403 fallback, i.e. exactly
  // the hosts that already had a bad day — its first-run wizard.
  const SKILL = 'skills/agentbox-setup/SKILL.md';

  it('the native recipe copies it', async () => {
    const { resolveAgentSpec } = await import('../src/sync/registry.js');
    const { resolveAgentInstall } = await import('../src/sync/agents/types.js');
    const install = resolveAgentInstall(resolveAgentSpec('claude').install, 'native');
    expect(install.postInstall).toContain(SKILL);
  });

  it('the npm alternate copies it too', async () => {
    const { resolveAgentSpec } = await import('../src/sync/registry.js');
    const { resolveAgentInstall } = await import('../src/sync/agents/types.js');
    const install = resolveAgentInstall(resolveAgentSpec('claude').install, 'npm');
    // ...and it really is the npm recipe, not a silent fall-through to native.
    expect(JSON.stringify(install.recipe)).toContain('@anthropic-ai/claude-code');
    expect(install.postInstall).toContain(SKILL);
  });
});
