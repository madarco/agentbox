import { describe, expect, it } from 'vitest';
import { cloneIdentityDir } from '../src/commands/clone.js';

describe("the clone requester's git identity", () => {
  it("is read from the source box's project when that folder is on this machine", async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'agentbox-clone-gitid-'));
    try {
      expect(cloneIdentityDir(dir, '/cwd')).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the working directory for a project that lives on the hub', () => {
    expect(cloneIdentityDir('/srv/hub-only/project-that-is-not-here', '/cwd')).toBe('/cwd');
    expect(cloneIdentityDir(undefined, '/cwd')).toBe('/cwd');
  });

  it('is sent with the clone request, and a missing one is warned about', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/commands/clone.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('gitIdentity: identity.identity');
    expect(src).toContain('missingGitIdentityWarning(identity.problem)');
  });
});
