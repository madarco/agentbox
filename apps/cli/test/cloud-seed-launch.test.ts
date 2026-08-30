import { describe, expect, it, vi } from 'vitest';

/**
 * Every cloud LAUNCH funnels through `cloudAgentAttach` or
 * `cloudAgentStartDetached` — `<agent> start`, `<agent> attach`, the generic
 * `agentbox attach`, the `-i` queue worker and restore-on-resume. Both must
 * place the agent's declared `seeds`.
 *
 * This is pinned because the first version of the fix put the call on the CLI
 * action closures instead, which are two separate bodies: it seeded on
 * `attach` and silently not on `start`, and a live Hetzner box was the only
 * thing that noticed.
 */
const m = vi.hoisted(() => ({
  seedAgentDeclaredFilesViaTransport: vi.fn(),
  startDetachedCloudAgent: vi.fn(),
  providerForBox: vi.fn(),
  syncTransport: vi.fn(() => ({ kind: 'transport' })),
}));

vi.mock('@agentbox/sandbox-cloud', () => ({
  buildCloudAttachInnerCommand: vi.fn(() => 'cmd'),
  seedAgentDeclaredFilesViaTransport: m.seedAgentDeclaredFilesViaTransport,
  startDetachedCloudAgent: m.startDetachedCloudAgent,
  startDetachedSession: vi.fn(),
  verifyDetachedSession: vi.fn(),
}));
vi.mock('../src/provider/registry.js', () => ({ providerForBox: m.providerForBox }));
vi.mock('../src/agent-sessions.js', () => ({ agentResumeArgs: vi.fn(async () => null) }));

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudAgentStartDetached } from '../src/commands/_cloud-attach.js';

const box = { id: 'b1', name: 'demo', provider: 'hetzner', workspacePath: '/ws' } as never;

describe('cloud launch seeds the agent’s declared files', () => {
  it('cloudAgentStartDetached seeds before starting the session', async () => {
    const order: string[] = [];
    m.seedAgentDeclaredFilesViaTransport.mockImplementation(() => {
      order.push('seed');
      return Promise.resolve({ seeded: [], uploaded: [] });
    });
    m.startDetachedCloudAgent.mockImplementation(() => {
      order.push('start');
      return Promise.resolve(box);
    });
    m.providerForBox.mockResolvedValue({ syncTransport: m.syncTransport });

    await cloudAgentStartDetached({ box, binary: 'opencode', sessionName: 'opencode' });

    // Before, not after: the agent reads its plugins at startup, so a seed that
    // lands afterwards does nothing until the next launch.
    expect(order).toEqual(['seed', 'start']);
    expect(m.seedAgentDeclaredFilesViaTransport).toHaveBeenCalledWith(
      { kind: 'transport' },
      'opencode',
    );
  });

  it('still launches when the provider exposes no transport', async () => {
    m.seedAgentDeclaredFilesViaTransport.mockReset();
    m.startDetachedCloudAgent.mockResolvedValue(box);
    m.providerForBox.mockResolvedValue({});
    await expect(
      cloudAgentStartDetached({ box, binary: 'opencode', sessionName: 'opencode' }),
    ).resolves.toBeUndefined();
    expect(m.seedAgentDeclaredFilesViaTransport).not.toHaveBeenCalled();
    expect(m.startDetachedCloudAgent).toHaveBeenCalled();
  });

  it('a failed seed never blocks the launch', async () => {
    m.seedAgentDeclaredFilesViaTransport.mockRejectedValue(new Error('sandbox unreachable'));
    m.startDetachedCloudAgent.mockResolvedValue(box);
    m.providerForBox.mockResolvedValue({ syncTransport: m.syncTransport });
    await expect(
      cloudAgentStartDetached({ box, binary: 'codex', sessionName: 'codex' }),
    ).resolves.toBeUndefined();
    expect(m.startDetachedCloudAgent).toHaveBeenCalled();
  });
});

describe('both launch primitives seed', () => {
  it('cloudAgentAttach calls the seeder too', () => {
    // `cloudAgentAttach` ends in a PTY + process.exit, so it is not callable
    // from a unit test the way the detached start is. Assert structurally
    // instead: what matters is that neither of the two primitives loses the
    // call, since between them they cover every cloud launch.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/commands/_cloud-attach.ts'),
      'utf8',
    );
    const calls = src.match(/await seedDeclaredFilesInCloudBox\(/g) ?? [];
    expect(calls.length).toBe(2);
    for (const fn of ['cloudAgentAttach', 'cloudAgentStartDetached']) {
      const body = src.slice(src.indexOf(`export async function ${fn}(`));
      expect(
        body.slice(0, body.indexOf('\nexport ') + 1 || undefined),
        `${fn} does not seed`,
      ).toContain('seedDeclaredFilesInCloudBox(');
    }
  });
});
