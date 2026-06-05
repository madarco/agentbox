import { describe, expect, it } from 'vitest';
import type { BoxStatus, BoxStatusServiceEntry, BoxStatusTaskEntry } from '@agentbox/ctl';
import { serviceStatusLabel } from '../../src/wrapped-pty/service-status.js';

function status(
  services: Array<Pick<BoxStatusServiceEntry, 'name' | 'state'> & { probed?: boolean }>,
  tasks: BoxStatusTaskEntry[] = [],
): BoxStatus {
  return {
    schema: 1,
    boxId: 'b',
    timestamp: '2026-01-01T00:00:00.000Z',
    services: services.map((s) => ({ port: null, ...s })),
    tasks,
    ports: [],
    claude: { state: 'idle', updatedAt: null, sessionRunning: false },
  };
}

describe('serviceStatusLabel', () => {
  it('returns null when the box declares no services or tasks', () => {
    expect(serviceStatusLabel(status([]))).toBeNull();
    expect(serviceStatusLabel(null)).toBeNull();
  });

  it('counts services up while still converging', () => {
    expect(
      serviceStatusLabel(
        status([
          { name: 'a', state: 'ready' },
          { name: 'b', state: 'starting' },
          { name: 'c', state: 'pending' },
        ]),
      ),
    ).toBe('starting 1/3…');
  });

  it('reports `ready` when every service is up', () => {
    expect(
      serviceStatusLabel(
        status([
          { name: 'a', state: 'ready' },
          { name: 'b', state: 'running' },
        ]),
      ),
    ).toBe('ready');
  });

  it('treats a probed service in `running` as still warming up (not yet up)', () => {
    // ready_when probe: `running` means the process started but the probe
    // hasn't passed, so it must not count toward `ready`.
    expect(serviceStatusLabel(status([{ name: 'a', state: 'running', probed: true }]))).toBe(
      'starting 0/1…',
    );
    expect(
      serviceStatusLabel(
        status([
          { name: 'a', state: 'ready' },
          { name: 'b', state: 'running', probed: true },
        ]),
      ),
    ).toBe('starting 1/2…');
  });

  it('counts a probed service as up only once it reaches `ready`', () => {
    expect(serviceStatusLabel(status([{ name: 'a', state: 'ready', probed: true }]))).toBe('ready');
  });

  it('counts an unprobed `running` service as up', () => {
    expect(serviceStatusLabel(status([{ name: 'a', state: 'running' }]))).toBe('ready');
  });

  it('escalates a crashed/unhealthy/backoff service to `service error`', () => {
    expect(serviceStatusLabel(status([{ name: 'a', state: 'crashed' }]))).toBe('service error');
    expect(
      serviceStatusLabel(
        status([
          { name: 'a', state: 'ready' },
          { name: 'b', state: 'unhealthy' },
        ]),
      ),
    ).toBe('service error');
  });

  it('escalates a failed task to `service error`', () => {
    expect(
      serviceStatusLabel(
        status([{ name: 'a', state: 'ready' }], [
          { name: 'build', state: 'failed' },
        ]),
      ),
    ).toBe('service error');
  });

  it('excludes a stopped service from the denominator', () => {
    expect(
      serviceStatusLabel(
        status([
          { name: 'a', state: 'ready' },
          { name: 'b', state: 'stopped' },
        ]),
      ),
    ).toBe('ready');
  });

  it('keeps `starting` while a setup task is still running, even with services up', () => {
    expect(
      serviceStatusLabel(
        status([{ name: 'a', state: 'ready' }], [
          { name: 'build', state: 'running' },
        ]),
      ),
    ).toBe('starting 1/1…');
  });

  it('handles a task-only box (no count)', () => {
    expect(serviceStatusLabel(status([], [{ name: 'build', state: 'running' }]))).toBe('starting…');
    expect(serviceStatusLabel(status([], [{ name: 'build', state: 'done' }]))).toBeNull();
  });
});
