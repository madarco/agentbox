import { describe, expect, it } from 'vitest';
import { decideSelfUpdate } from '../src/commands/update.js';

const decide = (o: Partial<Parameters<typeof decideSelfUpdate>[0]> = {}) =>
  decideSelfUpdate({
    installed: '0.27.0',
    newest: '0.28.0',
    target: 'stable',
    skipSelfFlag: false,
    ...o,
  });

describe('decideSelfUpdate', () => {
  it('installs when the registry has something newer', () => {
    expect(decide()).toEqual({ install: true, reason: 'newer' });
  });

  it('honours --skip-self above everything', () => {
    expect(decide({ skipSelfFlag: true, target: 'nightly' })).toEqual({
      install: false,
      reason: 'flag',
    });
  });

  it('does not reinstall when already on the newest', () => {
    expect(decide({ installed: '0.28.0', newest: '0.28.0' })).toEqual({
      install: false,
      reason: 'already-newest',
    });
  });

  it('refuses to downgrade a nightly that is ahead of the dist-tags', () => {
    // The normal state on nightly between publishes: `newest` is only "newest
    // PUBLISHED", and 0.28.0-nightly.5 > 0.27.0.
    expect(
      decide({ installed: '0.28.0-nightly.5', newest: '0.27.0', target: 'nightly' }),
    ).toEqual({ install: false, reason: 'already-newest' });
  });

  it('still installs a newer nightly over an older one', () => {
    expect(
      decide({ installed: '0.28.0-nightly.5', newest: '0.28.0-nightly.6', target: 'nightly' }),
    ).toEqual({ install: true, reason: 'newer' });
  });

  it('installs the stable release that supersedes a nightly (the crossover)', () => {
    expect(
      decide({ installed: '0.28.0-nightly.5', newest: '0.28.0', target: 'nightly' }),
    ).toEqual({ install: true, reason: 'newer' });
  });

  it('moves back to the newest release when opting OUT of nightly', () => {
    // The one sanctioned backward move: 0.27.0 sorts below the prerelease in hand,
    // but refusing it would leave the user stuck on the channel they just left.
    expect(
      decide({ installed: '0.28.0-nightly.5', newest: '0.27.0', target: 'stable' }),
    ).toEqual({ install: true, reason: 'switching' });
  });

  it('does NOT drag a nightly build back to stable when opting IN to nightly', () => {
    // `--channel nightly` while already on a nightly, with no newer nightly
    // published: the "leaving a channel" exception must not fire here, or asking
    // for nightly would install the older stable — the opposite of the request.
    expect(
      decide({ installed: '0.28.0-nightly.5', newest: '0.27.0', target: 'nightly' }),
    ).toEqual({ install: false, reason: 'already-newest' });
  });

  it('does not drag a post-crossover stable build back onto the prerelease it replaced', () => {
    // Reachable state: the user crossed over to 0.28.0 but `update.channel` is
    // still nightly, and the `nightly` tag still points at the prerelease that
    // release superseded. If the `latest` probe transiently fails, `newest` is
    // that older prerelease. Keying the backward move on "the channels differ"
    // would reinstall it. (Reported by Bugbot on #252.)
    expect(
      decide({ installed: '0.28.0', newest: '0.28.0-nightly.5', target: 'nightly' }),
    ).toEqual({ install: false, reason: 'already-newest' });
  });

  it('opting in from a stable build with no nightly published is a no-op', () => {
    // Membership still gets recorded by the caller; there is just nothing to install.
    expect(decide({ installed: '0.27.0', newest: '0.27.0', target: 'nightly' })).toEqual({
      install: false,
      reason: 'already-newest',
    });
  });

  it('falls back to installing when the registry was unreachable', () => {
    expect(decide({ newest: undefined })).toEqual({ install: true, reason: 'offline' });
  });
});
