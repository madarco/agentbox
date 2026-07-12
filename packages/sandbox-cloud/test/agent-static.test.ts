import { describe, expect, it } from 'vitest';
import { buildAgentStaticSeedCommands } from '../src/sync/agent-static.js';

const STAGES = [
  { kind: 'claude' as const, extractDir: '/home/vscode/.claude' },
  { kind: 'codex' as const, extractDir: '/home/vscode/.codex' },
];

describe('buildAgentStaticSeedCommands', () => {
  it('extracts each staged tarball into its own dir and cleans up after itself', () => {
    const cmds = buildAgentStaticSeedCommands(STAGES);
    const joined = cmds.join('\n');
    expect(joined).toContain('tar -xzf /tmp/agentbox-seed-claude.tar.gz -C /home/vscode/.claude');
    expect(joined).toContain('tar -xzf /tmp/agentbox-seed-codex.tar.gz -C /home/vscode/.codex');
    // Leaving multi-MB tarballs behind would bloat every snapshot baked from this box.
    expect(joined).toContain('rm -f /tmp/agentbox-seed-claude.tar.gz');
  });

  it('never switches user — there are no image layers here, so exec runs as vscode', () => {
    // The Dockerfile seed uses `USER root` / `USER vscode`. Against a live
    // sandbox those are meaningless; root steps must go through sudo instead.
    const joined = buildAgentStaticSeedCommands(STAGES, { claudeMdOverlay: true }).join('\n');
    expect(joined).not.toMatch(/^USER /m);
  });

  it('extracts as the box user so ownership is right by construction', () => {
    const joined = buildAgentStaticSeedCommands(STAGES).join('\n');
    // Extraction runs unprivileged (we already ARE vscode); the tar flags stop a
    // tarball from carrying root-owned entries or odd modes into the snapshot.
    expect(joined).toContain('--no-same-permissions --no-same-owner');
    expect(joined).toContain('chown -R vscode:vscode');
  });

  it('installs the CLAUDE.md overlay with sudo, only when one is supplied', () => {
    const withOverlay = buildAgentStaticSeedCommands(STAGES, { claudeMdOverlay: true }).join('\n');
    expect(withOverlay).toContain('sudo -n install -m 0644 /tmp/agentbox-custom-CLAUDE.md /etc/claude-code/CLAUDE.md');

    const without = buildAgentStaticSeedCommands(STAGES).join('\n');
    expect(without).not.toContain('/etc/claude-code/CLAUDE.md');
  });

  it('emits nothing to extract when no tool staged a tarball', () => {
    expect(buildAgentStaticSeedCommands([])).toEqual([]);
  });

  it('guards ~/.agents, which only exists when the host had one', () => {
    const joined = buildAgentStaticSeedCommands(STAGES).join('\n');
    expect(joined).toContain('[ -d /home/vscode/.agents ]');
    expect(joined).toContain('|| true');
  });
});
