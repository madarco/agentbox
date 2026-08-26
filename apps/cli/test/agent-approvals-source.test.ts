import { describe, expect, it } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import type { BoxStatusClaude } from '@agentbox/ctl';
import { gatherApprovals, missingHalves } from '../src/commands/agent.js';
import { boxAnswersOnLocalHub } from '../src/control-plane/box-plane.js';
import type { BoxPromptSource } from '../src/control-plane/box-plane.js';

// Pure: both halves of `gatherApprovals` are hub calls now, so a stub client is
// the whole world. The regression this pins: the in-TUI half used to read
// `~/.agentbox/boxes/<box>/status.json` off THIS machine's disk, which never
// exists for a box a control box created — those rows silently vanished and the
// box read as "agent not parked on a prompt".

const BOX = { id: 'b0x1', name: 'smoke' } as BoxRecord;

const PLAN: BoxStatusClaude = {
  state: 'waiting',
  updatedAt: '2026-08-26T00:00:00.000Z',
  sessionRunning: true,
  plan: { plan: '## do the thing', capturedAt: '2026-08-26T00:00:00.000Z' },
};

interface Stub {
  approvals?: unknown[];
  claude?: BoxStatusClaude | null;
  approvalsError?: Error;
  agentStateError?: Error;
}

/** A `BoxPromptSource` whose client answers from `stub` — no fs, no network. */
function source(stub: Stub, remote = true): BoxPromptSource {
  return {
    client: {
      listApprovals: async () => {
        if (stub.approvalsError) throw stub.approvalsError;
        return stub.approvals ?? [];
      },
      getAgentState: async () => {
        if (stub.agentStateError) throw stub.agentStateError;
        return { claude: stub.claude ?? null };
      },
    },
    baseUrl: 'https://cp.example',
    remote,
  } as unknown as BoxPromptSource;
}

describe('gatherApprovals in-TUI rows come from the owning hub', () => {
  it('surfaces a hub box plan prompt (the bug: it read a local file that never exists)', async () => {
    const g = await gatherApprovals(source({ claude: PLAN }), BOX);
    expect(g.rows.map((r) => r.kind)).toEqual(['plan']);
    expect(g.rows[0]?.id.startsWith('tui:b0x1:plan:')).toBe(true);
    expect(missingHalves(g)).toEqual([]);
  });

  it('reports no in-TUI row when the hub has no snapshot for the box', async () => {
    const g = await gatherApprovals(source({ claude: null }), BOX);
    expect(g.rows).toEqual([]);
    // Both halves ANSWERED — only then may the caller say "nothing pending".
    expect(missingHalves(g)).toEqual([]);
  });

  it('merges host-action rows with the in-TUI row, filtered to this box', async () => {
    const g = await gatherApprovals(
      source({
        claude: PLAN,
        approvals: [
          { id: 'u-1', boxId: 'b0x1', command: 'git', argv: ['push'], message: 'push?' },
          { id: 'u-2', boxId: 'other', command: 'git', argv: ['push'], message: 'push?' },
        ],
      }),
      BOX,
    );
    expect(g.rows.map((r) => r.id)).toEqual(['u-1', g.rows[1]?.id]);
    expect(g.rows.map((r) => r.kind)).toEqual(['host-action', 'plan']);
  });
});

describe('gatherApprovals degrades one half at a time', () => {
  it('keeps in-TUI rows when the approval mailbox fails', async () => {
    const g = await gatherApprovals(
      source({ claude: PLAN, approvalsError: new Error('502 bad gateway') }),
      BOX,
    );
    expect(g.rows.map((r) => r.kind)).toEqual(['plan']);
    expect(missingHalves(g)).toEqual(['host-action approvals (502 bad gateway)']);
  });

  it('keeps host-action rows when the agent snapshot fails', async () => {
    const g = await gatherApprovals(
      source({
        approvals: [{ id: 'u-1', boxId: 'b0x1', command: 'git', message: 'push?' }],
        agentStateError: new Error('ETIMEDOUT'),
      }),
      BOX,
    );
    expect(g.rows.map((r) => r.kind)).toEqual(['host-action']);
    // Non-empty is what stops the caller printing "nothing pending" — the whole
    // point of tracking the two failures separately.
    expect(missingHalves(g)).toEqual(["the agent's in-TUI prompts (ETIMEDOUT)"]);
  });

  it('names both when neither half answers', async () => {
    const g = await gatherApprovals(
      source({
        approvalsError: new Error('502 bad gateway'),
        agentStateError: new Error('ETIMEDOUT'),
      }),
      BOX,
    );
    expect(g.rows).toEqual([]);
    expect(missingHalves(g)).toEqual([
      'host-action approvals (502 bad gateway)',
      "the agent's in-TUI prompts (ETIMEDOUT)",
    ]);
  });
});

// Which hub owns a box — the decision BOTH `approvals` and `approve` now share.
// Bugbot Medium x2 on the first cut: an inline `provider === 'docker'` test sent
// a locally-created remote-docker box to the control box, which never wrote its
// snapshot, and made `approve` disagree with the listing that minted the id.
describe('boxAnswersOnLocalHub', () => {
  it('keeps a docker box local', () => {
    expect(boxAnswersOnLocalHub({ provider: 'docker' })).toBe(true);
    expect(boxAnswersOnLocalHub({})).toBe(true); // undefined provider defaults to docker
  });

  it('keeps a LOCALLY-created remote-docker box local', () => {
    // The container is on another machine's engine, but the box registers with
    // this laptop's relay — which is what writes its status.json and holds its
    // approval mailbox.
    expect(boxAnswersOnLocalHub({ provider: 'remote-docker' })).toBe(true);
  });

  it('sends a remote-docker box the CONTROL BOX created to that control box', () => {
    // `docker:hub`: same provider family, opposite owner. Only the recorded
    // plane can tell the two apart.
    expect(
      boxAnswersOnLocalHub({
        provider: 'remote-docker',
        cloud: { controlPlaneUrl: 'https://cp.example' },
      } as never),
    ).toBe(false);
  });

  it('sends cloud boxes to their plane', () => {
    for (const p of ['e2b', 'vercel', 'hetzner', 'daytona', 'digitalocean']) {
      expect(boxAnswersOnLocalHub({ provider: p }), p).toBe(false);
    }
  });
});

// A plane we can NAME but not authenticate to: `resolveBoxPromptSource` falls
// back to the local hub, which holds nothing for that box. Every reader has to
// say so — an empty answer from a hub we never asked is not "no snapshot".
describe('gatherApprovals on an unauthenticated plane', () => {
  it('does not let the local hub’s empty answer read as "nothing pending"', async () => {
    const s = source({ claude: null }, false);
    const withPlane: BoxPromptSource = { ...s, unauthenticatedPlane: 'https://cp.example' };
    const g = await gatherApprovals(withPlane, BOX);
    expect(g.rows).toEqual([]);
    // Both halves "answered" — so the caller must key off unauthenticatedPlane,
    // which is exactly what the approvals command does before saying anything.
    expect(missingHalves(g)).toEqual([]);
    expect(withPlane.unauthenticatedPlane).toBe('https://cp.example');
  });
});
