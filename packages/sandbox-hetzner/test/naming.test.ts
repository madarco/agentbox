import { describe, expect, it } from 'vitest';
import { HETZNER_MAX_NAME, hetznerLabelValue, hetznerResourceName } from '../src/naming.js';

// The name a control-box create mints: basename of its per-job clone dir + box id.
const HUB_NAME = 'agentbox-hub-worker-752faf01-891d-4f8e-bdb2-8d2085ce5398-b78777142';

describe('hetznerLabelValue', () => {
  it('leaves an ordinary box name alone', () => {
    expect(hetznerLabelValue('agentbox-b1a2b3c4')).toBe('agentbox-b1a2b3c4');
  });

  it('bounds the 66-char hub-minted name that produced the 422', () => {
    expect(HUB_NAME.length).toBeGreaterThan(HETZNER_MAX_NAME);
    const v = hetznerLabelValue(HUB_NAME);
    expect(v.length).toBeLessThanOrEqual(HETZNER_MAX_NAME);
    expect(v).toMatch(/^[a-zA-Z0-9][-_.a-zA-Z0-9]*[a-zA-Z0-9]$/);
  });

  it('replaces illegal characters and strips a non-alphanumeric start', () => {
    expect(hetznerLabelValue('_feature/JIRA 123')).toBe('feature-JIRA-123');
  });

  it('never ends on a separator after truncation', () => {
    // 63rd char lands on the hyphen — it must back off to the previous alphanumeric.
    const name = `${'a'.repeat(62)}-tail`;
    const v = hetznerLabelValue(name);
    expect(v).toBe('a'.repeat(62));
  });

  it('returns empty when nothing legal survives (callers fall back to the id)', () => {
    expect(hetznerLabelValue('///')).toBe('');
  });
});

describe('hetznerResourceName', () => {
  it('keeps prefix and stamp whole and fits in 63 chars', () => {
    const n = hetznerResourceName('agentbox', HUB_NAME, 'm1a2b3-c4d5e6');
    expect(n.length).toBeLessThanOrEqual(HETZNER_MAX_NAME);
    expect(n.startsWith('agentbox-')).toBe(true);
    expect(n.endsWith('-m1a2b3-c4d5e6')).toBe(true);
  });

  it('is unchanged for a short name', () => {
    expect(hetznerResourceName('agentbox', 'wispy-fox', 'm1a2b3')).toBe(
      'agentbox-wispy-fox-m1a2b3',
    );
  });

  it('drops the middle entirely when the name has nothing legal', () => {
    expect(hetznerResourceName('agentbox', '///', 'm1a2b3')).toBe('agentbox-m1a2b3');
  });
});
