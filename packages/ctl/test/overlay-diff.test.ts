import { describe, expect, it } from 'vitest';
import { lintOverlaySecrets, overlayPatch } from '../src/overlay-diff.js';

/**
 * The diff is the ONLY part of the layered-config render AgentBox performs
 * itself — the merge belongs to the tool's own patch command. So what these
 * cover is the one promise the diff makes: a key the user did not change in
 * `agentbox.yaml` never appears in the patch, which is exactly why an in-box
 * hand edit to that key survives a re-render.
 */
describe('overlayPatch', () => {
  it('sends the whole overlay when nothing was applied before', () => {
    const r = overlayPatch(undefined, { gateway: { port: 18789 }, mode: 'local' });
    expect(r.patch).toEqual({ gateway: { port: 18789 }, mode: 'local' });
    // Whole subtrees, not leaves: with no record there is nothing to diff
    // against, so the top-level key is the unit of change.
    expect(r.paths.sort()).toEqual(['gateway', 'mode']);
  });

  it('sends nothing when the overlay is unchanged', () => {
    const overlay = { gateway: { port: 18789, bind: 'loopback' } };
    const r = overlayPatch(overlay, structuredClone(overlay));
    expect(r.patch).toEqual({});
    expect(r.paths).toEqual([]);
  });

  it('sends only the changed leaf, not its siblings', () => {
    // The load-bearing case. `bind` is untouched in the yaml, so it is absent
    // from the patch, so the tool leaves whatever the user hand-edited it to.
    const r = overlayPatch(
      { gateway: { port: 18789, bind: 'loopback' } },
      { gateway: { port: 9999, bind: 'loopback' } },
    );
    expect(r.patch).toEqual({ gateway: { port: 9999 } });
    expect(r.paths).toEqual(['gateway.port']);
  });

  it('nulls a key removed from the overlay, so the edit is reversible', () => {
    const r = overlayPatch({ gateway: { port: 18789 } }, { gateway: {} });
    expect(r.patch).toEqual({ gateway: { port: null } });
    expect(r.removed).toEqual(['gateway.port']);
  });

  it('replaces an array whole rather than merging it element-wise', () => {
    const r = overlayPatch({ origins: ['a', 'b'] }, { origins: ['a'] });
    expect(r.patch).toEqual({ origins: ['a'] });
  });

  it('treats a scalar replacing an object as a replacement', () => {
    const r = overlayPatch({ gateway: { port: 1 } }, { gateway: 'off' });
    expect(r.patch).toEqual({ gateway: 'off' });
    expect(r.paths).toEqual(['gateway']);
  });

  it('adds a nested key without restating its parent', () => {
    const r = overlayPatch({ gateway: { port: 1 } }, { gateway: { port: 1, bind: 'loopback' } });
    expect(r.patch).toEqual({ gateway: { bind: 'loopback' } });
  });

  it('re-sends everything when the record is missing (the safe direction)', () => {
    const r = overlayPatch(undefined, { a: 1, b: { c: 2 } });
    expect(r.patch).toEqual({ a: 1, b: { c: 2 } });
  });
});

describe('lintOverlaySecrets', () => {
  it('flags a literal token under a secret-shaped key', () => {
    expect(
      lintOverlaySecrets({ gateway: { auth: { token: 'ghp_abcdefghijklmnopqrstuvwx' } } }),
    ).toEqual(['gateway.auth.token']);
  });

  it('does NOT flag a reference to one — that is the documented path', () => {
    expect(lintOverlaySecrets({ token: '{{AGENTBOX_AUTO_SECRET:gw}}' })).toEqual([]);
    expect(lintOverlaySecrets({ token: '$TELEGRAM_TOKEN' })).toEqual([]);
  });

  it('does not flag a short human value under a secret-shaped key', () => {
    expect(lintOverlaySecrets({ password: 'x' })).toEqual([]);
  });

  it('walks arrays so a secret in a list is still seen', () => {
    expect(lintOverlaySecrets({ channels: [{ apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' }] })).toEqual(
      ['channels[0].apiKey'],
    );
  });
});
