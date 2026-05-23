import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCommandLog } from '../src/lib/log-file.js';

describe('openCommandLog', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentbox-log-test-'));
    originalHome = process.env.AGENTBOX_HOME;
    process.env.AGENTBOX_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('creates logs/<command>.log under AGENTBOX_HOME', () => {
    const log = openCommandLog('create');
    expect(log.path).toBe(join(home, 'logs', 'create.log'));
    expect(existsSync(log.path)).toBe(true);
    log.write('hello');
    log.close();
    const body = readFileSync(log.path, 'utf8');
    expect(body).toContain('hello');
    expect(body).toContain('--- BEGIN create');
    expect(body).toContain('--- END create');
  });

  it('prefixes write() lines with an ISO timestamp', () => {
    const log = openCommandLog('claude');
    log.write('step one');
    log.close();
    const body = readFileSync(log.path, 'utf8');
    const lineWithStep = body.split('\n').find((l) => l.includes('step one'));
    expect(lineWithStep).toBeDefined();
    // ISO 8601: 2026-05-24T01:23:45.678Z
    expect(lineWithStep).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z step one$/);
  });

  it('raw() does not add a timestamp or newline', () => {
    const log = openCommandLog('codex');
    log.raw('chunk-no-newline');
    log.raw('-continued\n');
    log.close();
    const body = readFileSync(log.path, 'utf8');
    expect(body).toContain('chunk-no-newline-continued\n');
    // Make sure the chunk wasn't timestamp-prefixed.
    expect(body).not.toMatch(/Z chunk-no-newline/);
  });

  it('rotates: second open moves the first run to <command>.log.prev', () => {
    const a = openCommandLog('create');
    a.write('first run');
    a.close();
    const prev = a.path + '.prev';
    const b = openCommandLog('create');
    b.write('second run');
    b.close();
    expect(readFileSync(prev, 'utf8')).toContain('first run');
    expect(readFileSync(b.path, 'utf8')).toContain('second run');
    expect(readFileSync(b.path, 'utf8')).not.toContain('first run');
  });

  it('updates latest.log to point at the active file', () => {
    const log = openCommandLog('opencode');
    const link = join(home, 'logs', 'latest.log');
    // On posix this is a symlink; on Windows it'd be a text pointer.
    const st = statSync(link);
    expect(st.size).toBeGreaterThan(0);
    let target: string;
    try {
      target = readlinkSync(link);
    } catch {
      target = readFileSync(link, 'utf8').trim();
    }
    expect(target).toBe(log.path);
    log.close();
  });

  it('step() wraps BEGIN/END with elapsed ms on success', async () => {
    const log = openCommandLog('create');
    const out = await log.step('seed', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    });
    expect(out).toBe(42);
    log.close();
    const body = readFileSync(log.path, 'utf8');
    expect(body).toContain('--- BEGIN seed ---');
    expect(body).toMatch(/--- END seed \(\d+ms\) ---/);
  });

  it('step() writes FAIL and rethrows on error', async () => {
    const log = openCommandLog('create');
    await expect(
      log.step('boom', async () => {
        throw new Error('kaboom');
      }),
    ).rejects.toThrow('kaboom');
    log.close();
    const body = readFileSync(log.path, 'utf8');
    expect(body).toMatch(/--- FAIL boom \(\d+ms\): kaboom ---/);
  });

  it('close() is idempotent', () => {
    const log = openCommandLog('create');
    log.close();
    expect(() => log.close()).not.toThrow();
  });
});
