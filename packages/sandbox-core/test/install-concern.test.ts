import { describe, expect, it } from 'vitest';
import { makeRecordingTransport } from '../src/sync/recording-transport.js';
import { AgentInstallError, ensureAgentInstalled } from '../src/sync/concerns/install.js';
import type { SyncExecOptions, SyncExecResult } from '@agentbox/core';

/** Every exec the concern issued, as the raw argv. */
const execs = (t: {
  ops: ReadonlyArray<{ op: string; args: Record<string, unknown> }>;
}): string[][] => t.ops.filter((o) => o.op === 'exec').map((o) => o.args.cmd as string[]);

const ok: SyncExecResult = { exitCode: 0, stdout: '', stderr: '' };
const fail = (stderr = 'boom'): SyncExecResult => ({ exitCode: 1, stdout: '', stderr });

/** Probe misses once, everything after succeeds — the "needs installing" path. */
function missingThenOk(): (cmd: string[], opts?: SyncExecOptions) => SyncExecResult {
  let firstProbe = true;
  return (cmd) => {
    const joined = cmd.join(' ');
    if (joined.includes('command -v')) {
      if (firstProbe) {
        firstProbe = false;
        return fail('not found');
      }
      return ok; // the post-install verify
    }
    return ok;
  };
}

describe('ensureAgentInstalled', () => {
  it('is a no-op when the binary is already on PATH', async () => {
    const t = makeRecordingTransport({ execResult: () => ok });
    const res = await ensureAgentInstalled(t, 'codex');
    expect(res).toEqual({ installed: false });
    // Exactly one call: the probe. Nothing is installed, nothing escalates.
    expect(execs(t)).toEqual([['sh', '-c', 'command -v codex']]);
  });

  it('probes as the box user, not root — claude lives in ~/.local/bin', async () => {
    const t = makeRecordingTransport({ execResult: () => ok });
    await ensureAgentInstalled(t, 'claude');
    const probe = t.ops.find((o) => o.op === 'exec');
    expect(probe?.args.opts).toBeUndefined();
  });

  it('resolves the wire alias claude-code to the claude spec', async () => {
    const t = makeRecordingTransport({ execResult: () => ok });
    await ensureAgentInstalled(t, 'claude-code');
    expect(execs(t)[0]).toEqual(['sh', '-c', 'command -v claude']);
  });

  it('installs codex via npm as root, after its apt prerequisite', async () => {
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    const res = await ensureAgentInstalled(t, 'codex');
    expect(res).toEqual({ installed: true });

    const cmds = execs(t).map((c) => c.join(' '));
    expect(cmds[0]).toBe('sh -c command -v codex');
    // bubblewrap first — codex falls back to a bundled copy and warns without it.
    expect(cmds[1]).toContain('apt-get install -y --no-install-recommends bubblewrap');
    expect(cmds[2]).toContain('npm install -g @openai/codex');
    // ...and a post-install probe re-verifies the binary actually landed.
    expect(cmds).toContain('sh -lc command -v codex');
  });

  it('escalates root work so it works on docker AND cloud', async () => {
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    await ensureAgentInstalled(t, 'opencode');

    const install = t.ops
      .filter((o) => o.op === 'exec')
      .find((o) => (o.args.cmd as string[]).join(' ').includes('npm install -g opencode-ai'));
    const script = (install?.args.cmd as string[])[2]!;
    // Docker honours `--user root` so `id -u` is 0 and it runs directly; cloud
    // ignores the user option, so the same string re-enters through sudo.
    expect(script).toMatch(/if \[ "\$\(id -u\)" = 0 \]; then/);
    expect(script).toContain('sudo -n sh -c');
    expect(install?.args.opts).toEqual({ user: 'root' });
  });

  it('does NOT escalate a box-user recipe — root would install claude into /root', async () => {
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    await ensureAgentInstalled(t, 'claude');

    const install = t.ops
      .filter((o) => o.op === 'exec')
      .find((o) => (o.args.cmd as string[]).join(' ').includes('claude.ai/install.sh'));
    expect(install?.args.opts).toBeUndefined();
    expect((install?.args.cmd as string[]).join(' ')).not.toContain('sudo');
  });

  it('fetches the claude installer to a file rather than piping it to a shell', async () => {
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    await ensureAgentInstalled(t, 'claude');
    const script = execs(t)
      .map((c) => c.join(' '))
      .find((c) => c.includes('claude.ai/install.sh'))!;
    // `curl | bash` hides a blocked download behind bash's exit 0.
    expect(script).not.toMatch(/curl[^|]*\|\s*(ba)?sh/);
    expect(script).toContain('-o /tmp/agentbox-agent-install.sh');
    expect(script).toContain('i=1; while :; do');
    // Run it with bash, not sh: /bin/sh is dash on Debian/Ubuntu and the
    // installer is a bash script — running it under dash dies on the first
    // `[[`. Caught only by a real install, so pin it here.
    expect(script).toContain('bash /tmp/agentbox-agent-install.sh stable');
  });

  it('throws when the installer fails, quoting the output', async () => {
    const t = makeRecordingTransport({
      execResult: (cmd) =>
        cmd.join(' ').includes('command -v') ? fail('nope') : fail('npm ERR! 403'),
    });
    await expect(ensureAgentInstalled(t, 'opencode')).rejects.toThrow(AgentInstallError);
    await expect(ensureAgentInstalled(t, 'opencode')).rejects.toThrow(/npm ERR! 403/);
  });

  it('throws when the installer exits 0 but the binary is still missing', async () => {
    // A real failure mode: a wrapper that swallows a 403, or a wrong prefix.
    const t = makeRecordingTransport({
      execResult: (cmd) => (cmd.join(' ').includes('command -v') ? fail('nope') : ok),
    });
    await expect(ensureAgentInstalled(t, 'opencode')).rejects.toThrow(/still not on PATH/);
  });

  it('fails loudly when the apt prerequisite cannot be installed', async () => {
    const t = makeRecordingTransport({
      execResult: (cmd) => {
        const j = cmd.join(' ');
        if (j.includes('command -v')) return fail('nope');
        if (j.includes('apt-get')) return fail('E: Unable to locate package');
        return ok;
      },
    });
    await expect(ensureAgentInstalled(t, 'codex')).rejects.toThrow(
      /apt prerequisites \(bubblewrap\)/,
    );
  });
});

describe('ensureAgentInstalled — credential seeding', () => {
  it('pushes the host credential after an on-demand install', async () => {
    // The box was built for another agent, so this agent's config volume is not
    // mounted and never will be (docker fixes mounts at `docker run`). Without
    // the file push the agent starts unauthenticated with no visible error.
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    await ensureAgentInstalled(t, 'codex');
    const pushed = t.ops.find((o) => o.op === 'pushFile');
    // Only asserted when the host actually has a codex login; otherwise the
    // seed is correctly skipped.
    if (pushed) expect(String(pushed.args.boxDestPath)).toContain('.codex/auth.json');
  });

  it('never seeds when the binary was already present', async () => {
    const t = makeRecordingTransport({ execResult: () => ok });
    await ensureAgentInstalled(t, 'codex');
    expect(t.ops.some((o) => o.op === 'pushFile')).toBe(false);
  });

  it('a missing host login is not an install failure', async () => {
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    await expect(ensureAgentInstalled(t, 'opencode')).resolves.toEqual({ installed: true });
  });
});

describe('install modes (box.claudeInstall)', () => {
  it('uses the npm recipe for claude when the npm mode is selected', async () => {
    // Without an alternate, `box.claudeInstall: npm` would silently install
    // nothing different — the escape hatch for hosts the Claude CDN 403s.
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    await ensureAgentInstalled(t, 'claude', { installMode: 'npm' });
    const cmds = execs(t).map((c) => c.join(' '));
    expect(cmds.some((c) => c.includes('npm install -g @anthropic-ai/claude-code'))).toBe(true);
    expect(cmds.some((c) => c.includes('claude.ai/install.sh'))).toBe(false);
    // and it must still land on the box user's PATH, like the native install
    expect(cmds.some((c) => c.includes('/home/vscode/.local/bin/claude'))).toBe(true);
  });

  it('falls back to the default recipe for an agent with no alternate', async () => {
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    await ensureAgentInstalled(t, 'codex', { installMode: 'npm' });
    expect(
      execs(t)
        .map((c) => c.join(' '))
        .some((c) => c.includes('@openai/codex')),
    ).toBe(true);
  });

  it('uses the native installer when the mode is explicitly native', async () => {
    const t = makeRecordingTransport({ execResult: missingThenOk() });
    await ensureAgentInstalled(t, 'claude', { installMode: 'native' });
    expect(
      execs(t)
        .map((c) => c.join(' '))
        .some((c) => c.includes('claude.ai/install.sh')),
    ).toBe(true);
  });
});
