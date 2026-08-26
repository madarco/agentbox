import { describe, expect, it } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import type { BoxStatusClaude } from '@agentbox/ctl';
import { gatherApprovals, missingHalves } from '../src/commands/agent.js';
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
