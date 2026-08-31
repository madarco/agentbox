import { describe, expect, it } from 'vitest';
import { imageProgress, isImageDecisionLine } from '@agentbox/cli-kit';

// The point of this filter: the ONE line that explains a ten-minute rebuild must
// reach the command log, and docker's ~100 per-layer lines must not bury it.
// Before this existed, `ensureImage` progress went only to the self-overwriting
// spinner, so a rate-limited pull was indistinguishable from an unpublished tag
// when reading the logs afterwards.
describe('isImageDecisionLine', () => {
  it('keeps the decisions', () => {
    for (const l of [
      '[image] agentbox/box:dev: image agentbox/box:dev not present',
      '[image] agentbox/box:dev: build context changed (was abc, now def)',
      '[image] agentbox/box:dev: no docker-prepared.json on disk',
      '[image] pulling ghcr.io/madarco/agentbox/box:sha-54e4690b036d0225',
      '[image] pulled ghcr.io/x/box:sha-abc -> agentbox/box:dev',
      '[image] pull failed (rate-limit): toomanyrequests: retry-after 313s',
      '[image] pull failed (not-found): manifest unknown',
      '[image] retrying authenticated with your `gh` token',
      '[image] could not authenticate to ghcr.io: lacks read:packages',
      '[image] building agentbox/box:dev locally instead',
    ]) {
      expect(isImageDecisionLine(l), l).toBe(true);
    }
  });

  it('drops docker per-layer chatter', () => {
    for (const l of [
      '[image] 4f4fb700ef54: Pulling fs layer',
      '[image] cd75cb4d10ca: Download complete',
      '[image] 019502f7dbcf: Extracting',
      '[image] 4f4fb700ef54: Pull complete',
      '[image] 4f4fb700ef54: Already exists',
      '[image] 81e9d39fcad3: Verifying Checksum',
      '[image] 6adf63b8760e: Waiting',
    ]) {
      expect(isImageDecisionLine(l), l).toBe(false);
    }
  });
});

describe('imageProgress', () => {
  it('shows every line on the spinner regardless of the log filter', () => {
    const shown: string[] = [];
    const onProgress = imageProgress({ message: (l) => shown.push(l) });
    onProgress('[image] pulling ghcr.io/x/box:sha-abc');
    onProgress('[image] 4f4fb700ef54: Pulling fs layer');
    expect(shown).toHaveLength(2);
  });
});
