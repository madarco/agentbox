import { describe, expect, it } from 'vitest';
import { buildDaytonaSeedCommands } from '../src/prepare.js';

/**
 * Regression guard for the daytona static-seed bake. The Daytona builder only
 * lands `COPY` sources that map to a RELATIVE archive entry; an absolute
 * `addLocalFile`-style `COPY /abs/tmp/x` silently never applies. So every COPY
 * source the seed bake emits MUST be a relative basename (resolved against the
 * seed build-context dir), never an absolute path.
 */
describe('buildDaytonaSeedCommands', () => {
  const usable = [
    { kind: 'claude' as const, extractDir: '/home/vscode/.claude' },
    { kind: 'codex' as const, extractDir: '/home/vscode/.codex' },
    { kind: 'opencode' as const, extractDir: '/home/vscode/.local/share/opencode' },
    { kind: 'agents' as const, extractDir: '/home/vscode/.agents' },
  ];

  it('emits only RELATIVE COPY sources (never absolute)', () => {
    const cmds = buildDaytonaSeedCommands(usable);
    const copySources = cmds
      .filter((c) => c.startsWith('COPY '))
      .map((c) => c.split(/\s+/)[1] ?? ''); // COPY <src> <dest>
    expect(copySources.length).toBe(usable.length + 1); // + the CLAUDE.md overlay
    for (const src of copySources) {
      expect(src.startsWith('/')).toBe(false);
      expect(src).toMatch(/^agentbox-(seed-\w+\.tar\.gz|custom-CLAUDE\.md)$/);
    }
  });

  it('COPY dest for each tool matches its extract RUN', () => {
    const cmds = buildDaytonaSeedCommands(usable);
    for (const s of usable) {
      const remoteTar = `/tmp/agentbox-seed-${s.kind}.tar.gz`;
      expect(cmds).toContain(`COPY agentbox-seed-${s.kind}.tar.gz ${remoteTar}`);
      expect(
        cmds.some((c) => c.startsWith(`RUN mkdir -p ${s.extractDir}`) && c.includes(`tar -xzf ${remoteTar} -C ${s.extractDir}`)),
      ).toBe(true);
    }
  });

  it('brackets the root pass with USER root … USER vscode', () => {
    const cmds = buildDaytonaSeedCommands(usable);
    expect(cmds[0]).toBe('USER root');
    expect(cmds[cmds.length - 1]).toBe('USER vscode');
    expect(cmds.some((c) => c.includes('chown -R vscode:vscode'))).toBe(true);
  });

  it('still seeds the CLAUDE.md overlay when no host static config staged', () => {
    const cmds = buildDaytonaSeedCommands([]);
    expect(cmds).toContain('COPY agentbox-custom-CLAUDE.md /tmp/agentbox-custom-CLAUDE.md');
    // No tarball COPYs / chown pass when nothing is usable.
    expect(cmds.some((c) => c.includes('agentbox-seed-'))).toBe(false);
    expect(cmds.some((c) => c.includes('chown -R'))).toBe(false);
    expect(cmds[cmds.length - 1]).toBe('USER vscode');
  });
});
