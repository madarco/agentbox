import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every box-create call site must resolve its image with `resolveBoxImage`, not
 * the bare `box.image`.
 *
 * `agentbox prepare` pins the base it bakes into the PER-PROVIDER key
 * (`box.imageDaytona`, `box.imageHetzner`, …) — the generic `box.image` is
 * deliberately left alone, because one project can target several providers and
 * a snapshot id from one is meaningless (or poison) to another. Only
 * `resolveBoxImage(cfg, provider)` reads those keys.
 *
 * `agentbox create` always did. The agent entry points (`agentbox daytona
 * claude`, codex, opencode), the queued-job worker and the dashboard did not:
 * they passed the generic key, so the provider got the default image sentinel
 * instead of the snapshot that had just been baked for it. On daytona's
 * linux-vm class that isn't a slow fallback but a hard failure — a VM can only
 * boot from a prebuilt snapshot — so `agentbox daytona claude` died with "no
 * linux-vm base snapshot ... run `agentbox prepare`" immediately after prepare
 * had succeeded.
 *
 * This is a source-level check because the create paths are deep inside
 * commander actions that shell out to real providers; asserting on the wiring is
 * what's actually cheap to keep honest.
 */
const CREATE_CALL_SITES = [
  'claude.ts',
  'codex.ts',
  'opencode.ts',
  '_run-queued-job.ts',
  'dashboard.ts',
];

/** `image:` fields on a create request — excludes the throwaway login containers. */
const RAW_IMAGE_IN_CREATE = /image:\s*cfg\.effective\.box\.image\b/;

describe('box-create call sites resolve the per-provider image', () => {
  for (const file of CREATE_CALL_SITES) {
    it(`${file} passes resolveBoxImage() into its create request`, () => {
      const src = readFileSync(join(__dirname, '..', 'src', 'commands', file), 'utf8');
      const createBlocks = src
        .split(/cloudAgentCreate\(\{|createBox\(\{/)
        .slice(1)
        .map((block) => block.slice(0, block.indexOf('});')));

      expect(createBlocks.length).toBeGreaterThan(0);
      for (const block of createBlocks) {
        expect(RAW_IMAGE_IN_CREATE.test(block)).toBe(false);
        expect(block).toMatch(/image:\s*resolveBoxImage\(/);
      }
    });
  }
});
