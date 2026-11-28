import { describe, expect, it, vi } from 'vitest';
import type { CredentialsDeadEvent, HistoryIngestSink } from '@agentbox/core';
import { handleCredentialsDead, parseCredentialsDead } from '../src/credentials-dead.js';

const PAYLOAD = { schema: 1, agent: 'claude', wipedAt: '2026-11-28T10:00:00.000Z' };

function sink(record?: (e: CredentialsDeadEvent) => Promise<void>): HistoryIngestSink {
  return {
    ingest: () => Promise.resolve({ ok: true, offset: 0, sha256: '' }),
    ...(record ? { recordCredentialsDead: record } : {}),
  };
}

describe('parseCredentialsDead', () => {
  it('takes the watcher payload and refuses anything else', () => {
    expect(parseCredentialsDead(PAYLOAD)).toEqual({
      agent: 'claude',
      wipedAt: '2026-11-28T10:00:00.000Z',
    });
    expect(parseCredentialsDead({ ...PAYLOAD, schema: 2 })).toBeNull();
    expect(parseCredentialsDead({ ...PAYLOAD, agent: '../x' })).toBeNull();
    expect(parseCredentialsDead({ ...PAYLOAD, wipedAt: 'yesterday' })).toBeNull();
    expect(parseCredentialsDead(null)).toBeNull();
  });
});

describe('handleCredentialsDead', () => {
  it("records the event on the hub's sink with the box's id and name", async () => {
    const record = vi.fn(() => Promise.resolve());
    const r = await handleCredentialsDead(sink(record), { boxId: 'b1', name: 'smoke' }, PAYLOAD);
    expect(r.recorded).toBe(true);
    expect(record).toHaveBeenCalledWith({
      boxId: 'b1',
      boxName: 'smoke',
      agent: 'claude',
      ts: '2026-11-28T10:00:00.000Z',
    });
  });

  it('records nothing without a sink that keeps auth evidence, or on a bad payload', async () => {
    expect((await handleCredentialsDead(undefined, { boxId: 'b1' }, PAYLOAD)).recorded).toBe(false);
    expect((await handleCredentialsDead(sink(), { boxId: 'b1' }, PAYLOAD)).recorded).toBe(false);
    const record = vi.fn(() => Promise.resolve());
    expect((await handleCredentialsDead(sink(record), { boxId: 'b1' }, {})).recorded).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('never throws on a failing sink', async () => {
    const r = await handleCredentialsDead(
      sink(() => Promise.reject(new Error('db locked'))),
      { boxId: 'b1' },
      PAYLOAD,
    );
    expect(r).toEqual({ recorded: false, reason: 'db locked' });
  });
});
