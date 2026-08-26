import { describe, expect, it } from 'vitest';
import { parseVncTtl, vncUnavailableReason, VNC_TTL_MAX } from '../lib/boxes/vnc-link';
import { failFromAction } from '../app/(dashboard)/api/v1/lib/envelope';

describe('parseVncTtl', () => {
  it('treats an absent ttl as the provider default', () => {
    expect(parseVncTtl(null)).toEqual({ ok: true });
    expect(parseVncTtl('')).toEqual({ ok: true });
  });

  it('accepts whole seconds inside the clamp', () => {
    expect(parseVncTtl('3600')).toEqual({ ok: true, ttl: 3600 });
    expect(parseVncTtl('1')).toEqual({ ok: true, ttl: 1 });
    expect(parseVncTtl(String(VNC_TTL_MAX))).toEqual({ ok: true, ttl: VNC_TTL_MAX });
  });

  it('rejects out-of-range and non-integer values', () => {
    for (const bad of ['0', '86401', 'abc', '1.5', '-5', ' 60']) {
      const r = parseVncTtl(bad);
      expect(r.ok, `expected ${bad} to be rejected`).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/ttl/);
    }
  });
});

describe('vncUnavailableReason', () => {
  const live = { name: 'smoke', vncEnabled: true, vncPassword: 'pw' };

  it('passes a running, VNC-enabled box', () => {
    expect(vncUnavailableReason(live, 'running')).toBeNull();
  });

  it('refuses a box created with --no-vnc', () => {
    expect(vncUnavailableReason({ ...live, vncEnabled: false }, 'running')).toMatch(/--no-vnc/);
  });

  it('refuses a box with no recorded password', () => {
    const why = vncUnavailableReason({ ...live, vncPassword: undefined }, 'running');
    expect(why).toMatch(/password/);
  });

  it('refuses a box that is not running, naming the state', () => {
    expect(vncUnavailableReason(live, 'paused')).toMatch(/paused/);
    expect(vncUnavailableReason(live, 'stopped')).toMatch(/stopped/);
  });

  it('maps a deleted sandbox to a 404 and every other refusal to a 409', () => {
    // The wording is load-bearing: failFromAction's regex is what picks the status.
    const missing = vncUnavailableReason(live, 'missing');
    expect(missing).not.toBeNull();
    expect(failFromAction(missing as string).status).toBe(404);

    for (const state of ['paused', 'stopped'] as const) {
      expect(failFromAction(vncUnavailableReason(live, state) as string).status).toBe(409);
    }
    expect(
      failFromAction(vncUnavailableReason({ ...live, vncEnabled: false }, 'running') as string)
        .status,
    ).toBe(409);
  });
});
