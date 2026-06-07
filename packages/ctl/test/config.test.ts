import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('returns empty services for empty or absent doc', () => {
    expect(parseConfig('')).toEqual({ services: [], tasks: [], replacements: {} });
    expect(parseConfig('services: {}')).toEqual({ services: [], tasks: [], replacements: {} });
  });

  it('parses a minimal service with shell-string command', () => {
    const cfg = parseConfig(`
services:
  web:
    command: pnpm dev
`);
    expect(cfg.services).toHaveLength(1);
    const svc = cfg.services[0]!;
    expect(svc.name).toBe('web');
    expect(svc.command).toBe('pnpm dev');
    expect(svc.autostart).toBe(true);
    expect(svc.restart).toBe('on-failure');
    expect(svc.backoff.initialMs).toBe(500);
  });

  it('parses argv command + env + restart policy + backoff', () => {
    const cfg = parseConfig(`
services:
  worker:
    command: ["node", "worker.js"]
    cwd: apps/worker
    env:
      LOG_LEVEL: debug
      PORT: 4000
    restart: always
    backoff:
      initial_ms: 1000
      max_ms: 60000
      factor: 3
`);
    const svc = cfg.services[0]!;
    expect(svc.command).toEqual(['node', 'worker.js']);
    expect(svc.cwd).toBe('apps/worker');
    expect(svc.env).toEqual({ LOG_LEVEL: 'debug', PORT: '4000' });
    expect(svc.restart).toBe('always');
    expect(svc.backoff).toEqual({ initialMs: 1000, maxMs: 60000, factor: 3 });
  });

  it('rejects empty command', () => {
    expect(() => parseConfig(`services:\n  web:\n    command: ""\n`)).toThrow(ConfigError);
  });

  it('rejects empty argv', () => {
    expect(() => parseConfig(`services:\n  web:\n    command: []\n`)).toThrow(ConfigError);
  });

  it('rejects unknown restart policy', () => {
    expect(() => parseConfig(`services:\n  web:\n    command: foo\n    restart: maybe\n`)).toThrow(
      /restart must be one of/,
    );
  });

  it('rejects max < initial backoff', () => {
    expect(() =>
      parseConfig(`
services:
  web:
    command: foo
    backoff:
      initial_ms: 5000
      max_ms: 100
`),
    ).toThrow(/max_ms must be >= initial_ms/);
  });

  it('rejects invalid service name', () => {
    expect(() => parseConfig(`services:\n  "bad name":\n    command: foo\n`)).toThrow(/must match/);
  });
});
