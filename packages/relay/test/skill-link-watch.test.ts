import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeSkillLinks } from '@agentbox/sandbox-core';
import { startSkillLinkWatcher } from '../src/skill-link-watch.js';

describe('linked skill folder watcher', () => {
  const homes: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  it('debounces changes into one upload per quiet period and ignores .git', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-links-'));
    homes.push(home);
    await writeSkillLinks([{ name: 's', path: '/abs/s', linkedAt: '' }], home);
    const listeners: ((e: string, f: string) => void)[] = [];
    const watchImpl = vi.fn((_p: string, _o: unknown, cb: (e: string, f: string) => void) => {
      listeners.push(cb);
      return Object.assign(new EventEmitter(), { close: vi.fn() });
    });
    const uploads: string[] = [];
    const w = startSkillLinkWatcher({
      log: () => undefined,
      home,
      debounceMs: 20,
      rescanMs: 60_000,
      watchImpl: watchImpl as never,
      runImport: (l) => {
        uploads.push(l.name);
        return Promise.resolve();
      },
    });
    await w.rescan();
    expect(watchImpl).toHaveBeenCalledWith('/abs/s', { recursive: true }, expect.any(Function));
    listeners[0]!('change', 'SKILL.md');
    listeners[0]!('change', 'SKILL.md');
    listeners[0]!('change', '.git/index');
    await new Promise((r) => setTimeout(r, 60));
    expect(uploads).toEqual(['s']);
    listeners[0]!('change', '.git/HEAD');
    await new Promise((r) => setTimeout(r, 60));
    expect(uploads).toEqual(['s']);
    await w.stop();
  });

  it('drops the watch when the link is removed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'skill-links-'));
    homes.push(home);
    await writeSkillLinks([{ name: 's', path: '/abs/s', linkedAt: '' }], home);
    const close = vi.fn();
    const w = startSkillLinkWatcher({
      log: () => undefined,
      home,
      rescanMs: 60_000,
      watchImpl: (() => Object.assign(new EventEmitter(), { close })) as never,
      runImport: () => Promise.resolve(),
    });
    await w.rescan();
    await writeSkillLinks([], home);
    await w.rescan();
    expect(close).toHaveBeenCalled();
    await w.stop();
  });
});
