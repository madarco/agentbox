import { afterEach, describe, expect, it } from 'vitest';
import { recordBoxGitPush, recordCreateJobTimeline } from '../src/timeline-hooks.js';
import {
  configureTimelineSink,
  type TimelineSink,
  type TimelineWorkspaceRef,
} from '../src/workspaces/timeline-sink.js';
import type { TimelineEventInput } from '../src/workspaces/timeline-store.js';
import type { QueueJob } from '../src/queue.js';

interface Recorded {
  wsId: string;
  input: TimelineEventInput;
}

function stubSink(
  opts: { workspace?: TimelineWorkspaceRef | null; record?: () => Promise<never> } = {},
): { sink: TimelineSink; recorded: Recorded[]; keys: string[] } {
  const recorded: Recorded[] = [];
  const workspace = opts.workspace === undefined ? { id: 'ws1' } : opts.workspace;
  const sink: TimelineSink = {
    kind: 'remote',
    record: async (wsId, input) => {
      if (opts.record) return opts.record();
      recorded.push({ wsId, input });
      return null;
    },
    workspaceFor: async () => workspace,
  };
  return { sink, recorded, keys: [] };
}

const PUSH_CTX = {
  boxId: 'box1',
  boxName: 'smoke',
  hostPath: '/home/me/work/storefront',
  branch: 'agentbox/smoke',
  originUrl: 'git@github.com:acme/storefront.git',
};

function job(over: Partial<QueueJob> = {}): QueueJob {
  return {
    id: 'j1',
    status: 'done',
    kind: 'create',
    agent: 'claude-code',
    boxId: 'box9',
    createOpts: {
      workspace: '/tmp/hub-worker-clone',
      repoUrl: 'git@github.com:acme/storefront.git',
    },
    maxConcurrent: 1,
    createdAt: new Date().toISOString(),
    logPath: '/tmp/j1.log',
    ...over,
  } as QueueJob;
}

afterEach(() => {
  configureTimelineSink(null);
});

describe('the relay timeline hooks', () => {
  it('write a box push through the configured sink', async () => {
    const { sink, recorded } = stubSink();
    configureTimelineSink(sink);
    await recordBoxGitPush(PUSH_CTX, { hostInitiated: false, hostOnly: false }, { exitCode: 0 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      wsId: 'ws1',
      input: { type: 'git.push', actor: 'box', boxId: 'box1', branch: 'agentbox/smoke' },
    });
  });

  it('leave the RPC result untouched when the sink cannot record', async () => {
    const { sink } = stubSink({ record: () => Promise.reject(new Error('control box down')) });
    configureTimelineSink(sink);
    await expect(
      recordBoxGitPush(PUSH_CTX, { hostInitiated: false, hostOnly: false }, { exitCode: 0 }),
    ).resolves.toBeUndefined();
  });

  it('record nothing when no workspace lists the box', async () => {
    const { sink, recorded } = stubSink({ workspace: null });
    configureTimelineSink(sink);
    await recordBoxGitPush(PUSH_CTX, { hostInitiated: false, hostOnly: false }, { exitCode: 0 });
    expect(recorded).toEqual([]);
  });

  it('key a finished create job so a retried report lands once', async () => {
    const { sink, recorded } = stubSink();
    configureTimelineSink(sink);
    await recordCreateJobTimeline(job());
    await recordCreateJobTimeline(job());
    expect(recorded.map((r) => r.input.key)).toEqual(['job:j1:ready', 'job:j1:ready']);
    expect(recorded[0]?.input).toMatchObject({ type: 'box.ready', actor: 'hub', boxId: 'box9' });
  });

  it('join a create job by its repo: a worker clone is no workspace folder', async () => {
    const keys: { originUrl?: string; projectRoot?: string }[] = [];
    configureTimelineSink({
      kind: 'remote',
      record: async () => null,
      workspaceFor: async (key) => {
        keys.push(key);
        return { id: 'ws1' };
      },
    });
    await recordCreateJobTimeline(job());
    expect(keys[0]).toMatchObject({
      originUrl: 'git@github.com:acme/storefront.git',
      projectRoot: '/tmp/hub-worker-clone',
    });
  });

  it('say a failed job failed, with its reason', async () => {
    const { sink, recorded } = stubSink();
    configureTimelineSink(sink);
    await recordCreateJobTimeline(job({ status: 'failed', reason: 'provider refused' }));
    expect(recorded[0]?.input).toMatchObject({
      type: 'box.failed',
      key: 'job:j1:failed',
      text: 'provider refused',
    });
  });
});
