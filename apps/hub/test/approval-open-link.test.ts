import { describe, expect, it } from 'vitest';
import { parseAnswer } from '../app/(dashboard)/api/v1/lib/validate';

/**
 * `openedByClient` is the flag that keeps a link from opening twice — once on
 * the machine that claimed it and once more wherever the relay happens to run.
 * The tray has shipped it since before the hub emitted `open-link`, so the
 * route must accept it rather than silently dropping it into the ether.
 */
describe('parseAnswer: openedByClient', () => {
  it('passes the flag through when true', () => {
    const r = parseAnswer({ answer: 'y', openedByClient: true });
    expect(r).toEqual({ ok: true, value: { answer: 'y', openedByClient: true } });
  });

  it('omits it when false or absent, so a plain answer stays a plain answer', () => {
    expect(parseAnswer({ answer: 'y', openedByClient: false })).toEqual({
      ok: true,
      value: { answer: 'y' },
    });
    expect(parseAnswer({ answer: 'n' })).toEqual({ ok: true, value: { answer: 'n' } });
  });

  it('rejects a non-boolean rather than coercing it', () => {
    const r = parseAnswer({ answer: 'y', openedByClient: 'yes' });
    expect(r.ok).toBe(false);
  });

  it('still carries cancelled alongside it', () => {
    expect(parseAnswer({ answer: 'n', cancelled: true, openedByClient: true })).toEqual({
      ok: true,
      value: { answer: 'n', cancelled: true, openedByClient: true },
    });
  });
});
