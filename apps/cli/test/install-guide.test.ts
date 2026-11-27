import { describe, expect, it } from 'vitest';
import { PROVIDER_NAMES } from '@agentbox/config';
import { renderNextSteps, visibleWidth } from '../src/install-guide.js';

const lines = (s: string): string[] => s.replace(/\n$/, '').split('\n');

describe('install "Next steps" guide', () => {
  it('fits in 80 visible columns for every provider, boxed', () => {
    for (const provider of PROVIDER_NAMES) {
      for (const isDefault of [true, false]) {
        const out = renderNextSteps({ provider, isDefault, columns: 80, color: true });
        expect(out, provider).toContain('╮');
        for (const l of lines(out)) {
          expect(visibleWidth(l), `${provider}: ${l}`).toBeLessThanOrEqual(80);
        }
      }
    }
  });

  it('falls back to 80 columns when stdout is not a TTY', () => {
    const out = renderNextSteps({ provider: 'docker', isDefault: true, color: false });
    for (const l of lines(out)) expect(visibleWidth(l)).toBeLessThanOrEqual(80);
  });

  it('keeps the box borders aligned', () => {
    const out = renderNextSteps({
      provider: 'hetzner',
      isDefault: false,
      columns: 80,
      color: true,
    });
    const widths = new Set(lines(out).slice(1).map(visibleWidth));
    expect(widths.size).toBe(1);
  });

  it('drops the box when the terminal is narrower than it', () => {
    const out = renderNextSteps({ provider: 'docker', isDefault: true, columns: 40, color: false });
    expect(out).not.toMatch(/[╮╯]/);
    expect(out).toContain('agentbox attach');
  });

  it('never dims the body text', () => {
    const out = renderNextSteps({ provider: 'docker', isDefault: true, columns: 80, color: true });
    // SGR 2 (dim) and 90 (bright black / gray) are near-illegible on a white background.
    expect(out).not.toMatch(/\x1b\[(2|90)m/);
  });

  it('drops the provider prefix only when it is the default', () => {
    const def = renderNextSteps({ provider: 'e2b', isDefault: true, color: false });
    const other = renderNextSteps({ provider: 'e2b', isDefault: false, color: false });
    expect(def).not.toContain('agentbox e2b claude');
    expect(other).toContain('agentbox e2b claude');
  });
});
