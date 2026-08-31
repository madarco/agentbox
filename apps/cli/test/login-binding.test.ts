import { describe, expect, it } from 'vitest';
import { claudeLoginBinding } from '../src/agents/claude/login-binding.js';
import { codexLoginBinding } from '@agentbox/agent-codex/cli';
import { opencodeLoginBinding } from '../src/agents/opencode/login-binding.js';
import { withLoginDefaults } from '@agentbox/cli-kit';

/**
 * The bindings moved out of `lib/agent-login-bindings.ts` and next to their
 * runtimes, which removed the last import edge pointing from the shared CLI
 * INTO the agents. This asserts the move was behaviour-preserving: each still
 * builds a `docker run` argv against its own config volume, and only claude
 * carries a post-success step.
 */
const IMAGE = 'agentbox/box:dev';

describe('per-agent login bindings', () => {
  it('each mounts its own config volume into the throwaway container', () => {
    const rows = [
      { name: 'claude', b: claudeLoginBinding({ image: IMAGE }) },
      { name: 'codex', b: codexLoginBinding({ image: IMAGE }) },
      { name: 'opencode', b: opencodeLoginBinding({ image: IMAGE }) },
    ];
    for (const { name, b } of rows) {
      expect(b.dockerArgv[0], name).toBe('run');
      expect(b.dockerArgv.join(' '), name).toContain(IMAGE);
      // Its own volume, never another agent's.
      const mounts = b.dockerArgv.filter((a) => a.includes(':/home/'));
      expect(mounts.length, `${name} mounts`).toBeGreaterThan(0);
      for (const other of rows.filter((r) => r.name !== name)) {
        expect(mounts.join(' '), `${name} must not mount ${other.name}`).not.toContain(
          `agentbox-${other.name}-config`,
        );
      }
    }
  });

  it('only claude has post-success work', () => {
    // The warm-up + host-backup mirror. A shared `finalize` on every agent
    // would be a field only one of them can fill.
    expect(Boolean(claudeLoginBinding({ image: IMAGE }).finalize)).toBe(true);
    expect(Boolean(codexLoginBinding({ image: IMAGE }).finalize)).toBe(false);
    expect(Boolean(opencodeLoginBinding({ image: IMAGE }).finalize)).toBe(false);
  });

  it("honours the user's own args over the agent's defaults", () => {
    const withArgs = codexLoginBinding({ image: IMAGE, extraArgs: ['--sso'] });
    expect(withArgs.dockerArgv).toContain('--sso');
  });

  it('withLoginDefaults falls back only when the user passed nothing', () => {
    const spec = { defaultArgs: ['--default'] } as never;
    expect(withLoginDefaults(spec, [])).toEqual(['--default']);
    expect(withLoginDefaults(spec, ['--mine'])).toEqual(['--mine']);
  });
});
