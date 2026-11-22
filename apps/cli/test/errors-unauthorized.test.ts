import { afterEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ error: [] as string[], info: [] as string[] }));
vi.mock('@clack/prompts', () => ({
  log: {
    error: (m: string) => logged.error.push(m),
    info: (m: string) => logged.info.push(m),
  },
}));

afterEach(() => {
  logged.error.length = 0;
  logged.info.length = 0;
  delete process.env.AGENTBOX_CONTROL_PLANE_URL;
  vi.restoreAllMocks();
});

describe('handleLifecycleError on a hub 401', () => {
  it('adds the re-login hint naming the configured hub', async () => {
    process.env.AGENTBOX_CONTROL_PLANE_URL = 'https://hub.example';
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { HubApiError } = await import('../src/control-plane/hub-api-client.js');
    const { handleLifecycleError } = await import('../src/commands/_errors.js');
    handleLifecycleError(new HubApiError('Missing or invalid credentials.', 'unauthorized', 401));
    expect(exit).toHaveBeenCalledWith(1);
    expect(logged.info.join('\n')).toContain('agentbox hub login https://hub.example');
  });

  it('says nothing extra for other errors', async () => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { handleLifecycleError } = await import('../src/commands/_errors.js');
    handleLifecycleError(new Error('boom'));
    expect(logged.info).toEqual([]);
  });
});
