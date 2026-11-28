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
      at: '2026-11-28T10:00:00.000Z',
      alive: false,
    });
    // credentials-alive carries `at`; a stray `alive` flag on a dead event means nothing.
    expect(parseCredentialsDead({ ...PAYLOAD, alive: true })?.alive).toBe(false);
    expect(
      parseCredentialsDead({ schema: 1, agent: 'claude', at: '2026-11-28T10:00:00.000Z' }, true),
    ).toEqual({ agent: 'claude', at: '2026-11-28T10:00:00.000Z', alive: true });
    expect(parseCredentialsDead({ ...PAYLOAD, schema: 2 })).toBeNull();
    expect(parseCredentialsDead({ ...PAYLOAD, agent: '../x' })).toBeNull();
    expect(parseCredentialsDead({ ...PAYLOAD, wipedAt: 'yesterday' })).toBeNull();
    expect(parseCredentialsDead(null)).toBeNull();
  });
});

describe('handleCredentialsDead', () => {
  it("records the event on the hub's sink with the box's id and name", async () => {
    const record = vi.fn(() => Promise.resolve());
    const r = await handleCredentialsDead(sink(record), { boxId: 'b1', name: 'smoke' }, PAYLOAD, {
      now: Date.parse('2026-11-28T11:00:00.000Z'),
    });
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

  it("clamps a box clock ahead of the relay's, and records credentials-alive as alive", async () => {
    const record = vi.fn<(e: CredentialsDeadEvent) => Promise<void>>(() => Promise.resolve());
    const now = Date.parse('2026-11-28T09:00:00.000Z');
    await handleCredentialsDead(sink(record), { boxId: 'b1' }, PAYLOAD, { now });
    expect(record.mock.calls[0]![0].ts).toBe('2026-11-28T09:00:00.000Z');
    await handleCredentialsDead(
      sink(record),
      { boxId: 'b1' },
      { schema: 1, agent: 'claude', at: '2026-11-28T08:00:00.000Z' },
      { alive: true, now },
    );
    expect(record.mock.calls[1]![0]).toMatchObject({ ts: '2026-11-28T08:00:00.000Z', alive: true });
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
