import { describe, expect, it } from 'vitest';
import { applySkipPermissions, type SkipPermissionsRule } from '@agentbox/cli-kit';
import { claudeRuntime } from '@agentbox/agent-claude/cli';
import { codexRuntime } from '@agentbox/agent-codex/cli';
import { opencodeRuntime } from '@agentbox/agent-opencode/cli';
import type { EffectiveConfig } from '@agentbox/config';

const cfg = (claudeOn: boolean, codexOn: boolean): EffectiveConfig =>
  ({
    claude: { dangerouslySkipPermissions: claudeOn },
    codex: { dangerouslySkipPermissions: codexOn },
  }) as unknown as EffectiveConfig;

const RULE: SkipPermissionsRule = {
  flag: '--go',
  conflictingArgs: ['--go', '--mode'],
};

// The mechanism, with no agent in it — this is all `lib/skip-permissions.ts`
// knows. Which flag and which conflicts are the agent's data, tested below.
describe('applySkipPermissions', () => {
  it('prepends the flag when enabled and no conflicting arg is present', () => {
    expect(applySkipPermissions(['-p', 'hi'], RULE, true)).toEqual(['--go', '-p', 'hi']);
  });

  it('does nothing when disabled', () => {
    expect(applySkipPermissions(['-p', 'hi'], RULE, false)).toEqual(['-p', 'hi']);
  });

  it('respects a conflicting arg in space syntax', () => {
    const args = ['--mode', 'plan'];
    expect(applySkipPermissions(args, RULE, true)).toEqual(args);
  });

  it('respects a conflicting arg in inline syntax', () => {
    const args = ['--mode=plan'];
    expect(applySkipPermissions(args, RULE, true)).toEqual(args);
  });

  it('leaves the caller array untouched', () => {
    const args = ['-p', 'hi'];
    applySkipPermissions(args, RULE, true);
    expect(args).toEqual(['-p', 'hi']);
  });
});

describe('claude runtime skip-permissions', () => {
  const apply = (args: string[], on: boolean) =>
    claudeRuntime.skipPermissions!.apply(args, cfg(on, false));

  it('prepends the bypass flag when the config enables it', () => {
    expect(apply(['-p', 'hi'], true)).toEqual(['--dangerously-skip-permissions', '-p', 'hi']);
  });

  it('does nothing when the config disables it', () => {
    expect(apply(['-p', 'hi'], false)).toEqual(['-p', 'hi']);
  });

  it('respects an explicit --permission-mode (space syntax)', () => {
    const args = ['--permission-mode', 'plan'];
    expect(apply(args, true)).toEqual(args);
  });

  it('respects an explicit --permission-mode=plan (inline syntax)', () => {
    const args = ['--permission-mode=plan'];
    expect(apply(args, true)).toEqual(args);
  });
});

describe('codex runtime skip-permissions', () => {
  const apply = (args: string[]) => codexRuntime.skipPermissions!.apply(args, cfg(false, true));

  it('prepends the bypass flag when enabled', () => {
    expect(apply(['hi'])).toEqual(['--dangerously-bypass-approvals-and-sandbox', 'hi']);
  });

  it('respects an explicit --ask-for-approval=never (inline syntax)', () => {
    const args = ['--ask-for-approval=never'];
    expect(apply(args)).toEqual(args);
  });

  it('respects a short -a approval flag', () => {
    const args = ['-a', 'never'];
    expect(apply(args)).toEqual(args);
  });
});

describe('an agent with no such flag', () => {
  it('declares it as null rather than being absent from the surface', () => {
    // OpenCode genuinely has no permission-bypass flag. `null` says so out
    // loud; omitting the agent would make an unimplemented arm and a
    // deliberate "none" indistinguishable.
    expect(opencodeRuntime.skipPermissions).toBeNull();
  });
});
