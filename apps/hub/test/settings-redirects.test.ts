import { describe, expect, it } from 'vitest';
import config from '../next.config.mjs';

describe('settings redirects', () => {
  it('sends the two shipped old paths to their Settings pages, permanently', async () => {
    const redirects = await config.redirects?.();
    expect(redirects).toEqual([
      { source: '/skills', destination: '/settings/skills', permanent: true },
      { source: '/devices', destination: '/settings/devices', permanent: true },
    ]);
  });
});
