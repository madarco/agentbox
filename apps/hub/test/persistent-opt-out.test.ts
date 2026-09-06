import { describe, expect, it } from 'vitest';

/**
 * What the create form must send for `opts.persistent`.
 *
 * Three-way, and the third is the bug: silence means "no opinion", so the hub
 * derives it (a service agent's box is always-on) and otherwise falls back to
 * `box.persistent`. On e2b/vercel the API REFUSES a derived `true`, so silence
 * there made every OpenClaw create fail while the toggle sat disabled and
 * unable to say otherwise.
 *
 * Mirrors the rule in `create-box-modal.tsx`; the component itself needs a DOM.
 */
function toSend(o: {
  capped: boolean;
  byDefault: boolean;
  effective: boolean;
}): boolean | undefined {
  if (o.capped) return o.byDefault ? false : undefined;
  return o.effective !== o.byDefault ? o.effective : undefined;
}

describe('create form opts.persistent', () => {
  it('says nothing when the user agrees with the derived default', () => {
    expect(toSend({ capped: false, byDefault: false, effective: false })).toBeUndefined();
    expect(toSend({ capped: false, byDefault: true, effective: true })).toBeUndefined();
  });

  it('sends the value when the user contradicts the default', () => {
    expect(toSend({ capped: false, byDefault: false, effective: true })).toBe(true);
    expect(toSend({ capped: false, byDefault: true, effective: false })).toBe(false);
  });

  it('opts out EXPLICITLY on a capped provider whose agent defaults to always-on', () => {
    // The regression: omitting it let the API derive `true` and refuse the
    // create — OpenClaw on e2b/vercel could never be made from the form.
    expect(toSend({ capped: true, byDefault: true, effective: false })).toBe(false);
  });

  it('still says nothing on a capped provider when nothing would derive true', () => {
    // A TUI agent there: `box.persistent` should still get its say.
    expect(toSend({ capped: true, byDefault: false, effective: false })).toBeUndefined();
  });
});
