// Restart a box's agent session on the hub, resuming its conversation: the hub
// twin of `restoreAgentSessions({restoreOnly, force})` in apps/cli, which the
// hub cannot import. Used after an account switch (hub settings 3c), when the
// running session holds the old account's env.
import { loadEffectiveConfig } from '@agentbox/config';
import type { BoxRecord, Provider } from '@agentbox/core';
import { loadAgentCliModule } from '@agentbox/agent-modules';
import { startDetachedCloudAgent } from '@agentbox/sandbox-cloud';
import { resolveAgentSpec, runModelAuthIngest } from '@agentbox/sandbox-core';

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export async function restartBoxAgent(
  provider: Provider,
  box: BoxRecord,
  agent: string,
): Promise<void> {
  const mod = await loadAgentCliModule(agent);
  if (!mod) throw new Error(`this hub cannot start ${agent} sessions`);
  const { runtime } = mod;
  const cfg = await loadEffectiveConfig(box.workspacePath).catch(() => null);
  const sessionName = cfg
    ? runtime.sessionNameOf(cfg.effective)
    : resolveAgentSpec(agent).sessionName;
  const execRead = async (script: string): Promise<string> => {
    try {
      const r = await provider.exec(box, ['bash', '-lc', script], { user: 'vscode' });
      return r.exitCode === 0 ? r.stdout.trim() : '';
    } catch {
      return '';
    }
  };

  await provider
    .exec(box, ['bash', '-lc', `tmux kill-session -t ${q(sessionName)} 2>/dev/null || true`], {
      user: 'vscode',
    })
    .catch(() => undefined);

  const resume = runtime.resume ? await runtime.resume.resumeArgs(execRead) : null;
  let args = resume ?? [];
  if (cfg && runtime.skipPermissions) args = runtime.skipPermissions.apply(args, cfg.effective);

  if ((box.provider ?? 'docker') === 'docker') {
    if ((box.borrowedCredentials ?? []).length > 0) {
      await runModelAuthIngest(resolveAgentSpec(agent), async (argv) => {
        const r = await provider.exec(box, argv, { user: 'vscode' });
        return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      });
    }
    await runtime.startSession({
      container: box.container,
      args,
      sessionName,
      boxName: box.name,
      workspacePath: box.workspacePath,
    });
    return;
  }
  await startDetachedCloudAgent({ provider, box, binary: agent, sessionName, extraArgs: args });
}
