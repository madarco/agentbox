import { describe, expect, it, vi } from 'vitest';
import type { HistoryRowCursor, HistoryShipper } from '@agentbox/core';
import { HistoryLoop, RpcTimeout, type HistoryConfigFetch } from '../src/history-shipper.js';

const enabled: HistoryConfigFetch = {
  kind: 'ok',
  config: { enabled: true, agents: [], credentialFiles: [] },
};

function loop(results: Array<HistoryConfigFetch | Error>) {
  const fetchConfig = vi.fn(async () => {
    const r = results.shift();
    if (r instanceof Error) throw r;
    return r ?? { kind: 'unreachable' as const };
  });
  const pass = vi.fn(async () => ({ files: 0, frames: 0, bytes: 0, redactions: 0, errors: [] }));
  const l = new HistoryLoop({
    fetchConfig,
    makeShipper: async () => ({ pass, isDisabled: false }) as unknown as HistoryShipper,
  });
  l.stop(); // no timers: drive tick() by hand
  return { l, fetchConfig, pass };
}

describe('HistoryLoop config backoff (review R1)', () => {
  it('does not re-ask an older relay that refused history.config', async () => {
    const { l, fetchConfig, pass } = loop([{ kind: 'unsupported' }, enabled]);
    await l.tick();
    await l.tick();
    await l.tick();
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    expect(pass).not.toHaveBeenCalled();
  });

  it('retries next tick when nothing answered at all', async () => {
    const { l, fetchConfig, pass } = loop([{ kind: 'unreachable' }, enabled]);
    await l.tick();
    await l.tick();
    expect(fetchConfig).toHaveBeenCalledTimes(2);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it('retries after a timeout (backing off its delay, not caching a non-answer)', async () => {
    const { l, fetchConfig, pass } = loop([new RpcTimeout('history.config timed out'), enabled]);
    await l.tick();
    await l.tick();
    expect(fetchConfig).toHaveBeenCalledTimes(2);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it('caches a disabled answer (docker box, opted-out project) for the window', async () => {
    const { l, fetchConfig } = loop([
      { kind: 'ok', config: { enabled: false, agents: [], credentialFiles: [] } },
      enabled,
    ]);
    await l.tick();
    await l.tick();
    expect(fetchConfig).toHaveBeenCalledTimes(1);
  });
});

describe('HistoryLoop row cursor (Phase 3)', () => {
  it('runs the row cursor for a docker box (materialize) without a shipper', async () => {
    const agent = { agent: 'opencode', configDir: '/x', projectKey: '-workspace', spec: { transcripts: [] } };
    const cursorPass = vi.fn(async () => ({ sessions: 0, rows: 0, errors: [] }));
    const makeRowCursor = vi.fn(
      () => ({ active: true, pass: cursorPass }) as unknown as HistoryRowCursor,
    );
    const makeShipper = vi.fn();
    const l = new HistoryLoop({
      fetchConfig: async () => ({
        kind: 'ok',
        config: { enabled: false, agents: [], materialize: [agent], credentialFiles: [] },
      }),
      makeShipper,
      makeRowCursor,
    });
    l.stop();
    expect(await l.tick(true)).toBeNull();
    expect(makeRowCursor).toHaveBeenCalledWith([agent]);
    expect(cursorPass).toHaveBeenCalledWith({ final: true });
    expect(makeShipper).not.toHaveBeenCalled();
  });
});
