import { describe, expect, it, vi } from 'vitest';
import type { BoxRecord, ExecResult, Provider } from '@agentbox/core';

/**
 * A plugin agent — `agentbox agent add <pkg>` — is in the registry but has no
 * CLI module in this build. `restoreAgentSessions` walks the registry, so it
 * meets one; `loadAgentModule` throws for it, and that throw sat OUTSIDE the
 * per-agent try/catch, taking the whole box start/unpause down.
 *
 * `plug` stands in for that agent: resumable (so it is walked) and absent from
 * `apps/cli/src/agents/index.ts` (so no module can load).
 */
vi.mock('@agentbox/sandbox-core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@agentbox/sandbox-core')>();
  const plug = {
    ...real.resolveAgentSpec('codex'),
    id: 'plug',
    sessionName: 'plug-session',
    caps: { ...real.resolveAgentSpec('codex').caps, resume: true },
  };
  return {
    ...real,
    agentIds: () => [...real.agentIds(), 'plug'],
    resolveAgentSpec: (id: string) => (id === 'plug' ? plug : real.resolveAgentSpec(id)),
  };
});

vi.mock('@agentbox/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentbox/config')>()),
  loadEffectiveConfig: vi.fn(async () => ({
    effective: { claude: { sessionName: 'claude' }, codex: { sessionName: 'codex' } },
  })),
}));

const cloudAgentStartDetached = vi.fn(() => Promise.resolve());
vi.mock('../src/commands/_cloud-attach.js', () => ({
  cloudAgentStartDetached: () => cloudAgentStartDetached(),
}));

const { restoreAgentSessions, resumableAgents } = await import('../src/agent-sessions.js');
const { loadAgentModuleOrNull, loadAgentModule } = await import('../src/agents/index.js');

const box = {
  id: 'b1',
  name: 'smoke',
  container: 'cloud:sb1',
  provider: 'daytona',
  workspacePath: '/tmp/ws',
} as BoxRecord;

function deadBoxProvider(): Provider {
  const exec = vi.fn(async (_b, argv: string[]): Promise<ExecResult> => {
    if (argv.join(' ').includes('has-session')) return { exitCode: 1, stdout: '', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { name: 'daytona', exec } as unknown as Provider;
}

describe('a plugin agent this build has no module for', () => {
  it('is walked by resumableAgents — that is what makes it reachable', () => {
    expect(resumableAgents()).toContain('plug');
  });

  it('has no CLI module, and loadAgentModule still says so loudly', async () => {
    await expect(loadAgentModule('plug')).rejects.toThrow(/no agent module/);
    expect(await loadAgentModuleOrNull('plug')).toBeNull();
  });

  it('does not take box start/unpause down with it', async () => {
    await expect(restoreAgentSessions(box, deadBoxProvider(), {})).resolves.toBeUndefined();
  });

  it('and a restoreOnly of it fails softly, reporting rather than throwing', async () => {
    const lines: string[] = [];
    await expect(
      restoreAgentSessions(box, deadBoxProvider(), {
        restoreOnly: 'plug',
        onLog: (l) => lines.push(l),
      }),
    ).resolves.toBeUndefined();
    expect(lines.join('\n')).toMatch(/could not start plug/);
  });
});
