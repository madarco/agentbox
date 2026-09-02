import { describe, expect, it } from 'vitest';
import type { AgentSyncSpec } from '@agentbox/core';
import { buildServiceAgentCommand } from '../src/agents/command/service-factory.js';

/**
 * The service-agent command surface, asserted on a THROWAWAY spec.
 *
 * No service agent ships yet (openclaw is Phase 6), so pinning this against the
 * registry would assert nothing. The factory is the deliverable, though, and its
 * contract is a negative one — a daemon must NOT be offered the TUI flags — so
 * the test builds a spec of its own and checks both halves: the subcommands a
 * hosted service needs, and the absence of everything `buildAgentCommand` adds
 * for a tmux session.
 */
const spec: AgentSyncSpec = {
  id: 'demosvc',
  aliases: [],
  sessionName: 'demosvc',
  binary: 'demosvc',
  install: { recipe: { kind: 'npm', package: 'demosvc' } },
  credential: {
    boxAbsPath: '/home/vscode/.demosvc/creds.json',
    hostRelPath: '.demosvc/creds.json',
    shape: 'opaque',
  },
  staticPaths: [{ boxDir: '/home/vscode/.demosvc', hostDir: '.demosvc' }],
  caps: { surface: 'service', resume: false, teleport: 'stub', activitySource: [] },
  service: {
    name: 'demosvc',
    command: 'demosvc gateway',
    restart: 'always',
    readyWhen: { http: 'http://127.0.0.1:18789/healthz' },
    expose: { port: 18789, as: 80 },
  },
} as unknown as AgentSyncSpec;

describe('buildServiceAgentCommand', () => {
  const command = buildServiceAgentCommand(spec);
  const subs = command.commands.map((c) => c.name()).sort();
  const flags = command.options.map((o) => o.long);

  it('is named for the agent and takes an optional box ref', () => {
    expect(command.name()).toBe('demosvc');
    expect(command.registeredArguments.map((a) => a.name())).toEqual(['box']);
    expect(command.registeredArguments[0]!.required).toBe(false);
  });

  it('offers the subcommands a hosted service actually has', () => {
    expect(subs).toEqual(['logs', 'restart', 'status', 'stop', 'url']);
  });

  it('offers NONE of the TUI surface — a flag that does nothing is worse than no flag', () => {
    for (const absent of [
      '--resume',
      '--continue',
      '--dangerously-skip-permissions',
      '--attach-in',
      '--detach',
    ]) {
      expect(flags, `${absent} must not exist on a service agent`).not.toContain(absent);
    }
    expect(subs).not.toContain('attach');
    expect(subs).not.toContain('login');
    expect(subs).not.toContain('start');
  });

  it('keeps the create-side flags a box still needs', () => {
    expect(flags).toEqual(
      expect.arrayContaining([
        '--workspace',
        '--name',
        '--provider',
        '--image',
        '--snapshot',
        '--yes',
        '--carry-yes',
        '--timeout',
      ]),
    );
  });

  it('refuses to build a command for an agent with no service block', () => {
    const noService = { ...spec, service: undefined } as unknown as AgentSyncSpec;
    expect(() => buildServiceAgentCommand(noService)).toThrow(/declares no service block/);
  });

  it('names the unit from the spec, so a workspace override matches by name', () => {
    // The unit name is public surface: declaring a service of the same name in
    // agentbox.yaml is the documented way to override the synthesized one.
    const status = command.commands.find((c) => c.name() === 'status')!;
    expect(status.description()).toContain(spec.service!.name);
  });
});
