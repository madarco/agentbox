import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';

// Mocked so the no-op assertions below can prove nothing was written WITHOUT
// touching the developer's real ~/.local/state/agentbox.
const fsMock = {
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const { AGENT_SESSION_POINTERS, markAgentActive, recordAgentSessionId, clearAgentSessionPointer } =
  await import('../src/session-pointer.js');

beforeEach(() => {
  fsMock.writeFileSync.mockClear();
  fsMock.rmSync.mockClear();
});

/**
 * These paths are a WIRE CONTRACT, and the asymmetry is what makes them
 * dangerous: the writer is the `agentbox-ctl` baked into a box's image, while
 * the reader is the host CLI, which greps the literal strings over
 * `provider.exec` on restart. A box built from an older snapshot writes the old
 * name for its whole life, so moving one costs every existing box its
 * resume-on-restart — silently, since a missing pointer just means "nothing to
 * resume".
 *
 * Hardcoded here on purpose. Deriving them from the same constants they are
 * asserting would make this test agree with any rename, which is the one thing
 * it must not do. The host-side readers are pinned by
 * `apps/cli/test/agent-sessions.test.ts`.
 */
describe('agent session pointer paths are frozen', () => {
  it('writes claude to ~/.local/state/agentbox/claude-session', () => {
    expect(AGENT_SESSION_POINTERS.claude?.path).toBe(
      `${homedir()}/.local/state/agentbox/claude-session`,
    );
    // Claude's hooks carry a resumable session_id.
    expect(AGENT_SESSION_POINTERS.claude?.kind).toBe('session-id');
  });

  it('writes codex to ~/.local/state/agentbox/codex-active', () => {
    expect(AGENT_SESSION_POINTERS.codex?.path).toBe(
      `${homedir()}/.local/state/agentbox/codex-active`,
    );
    // Codex exposes no resumable id — it resumes with `--last`, so presence is
    // all the pointer can carry.
    expect(AGENT_SESSION_POINTERS.codex?.kind).toBe('presence');
  });

  it('gives an agent with no pointer nothing, rather than a default path', () => {
    // A pointer for an agent the host never reads back would be a file written
    // into every box for no one.
    expect(AGENT_SESSION_POINTERS.opencode).toBeUndefined();
    expect(AGENT_SESSION_POINTERS.example).toBeUndefined();
  });
});

describe('a pointer only ever gets the shape its agent actually has', () => {
  it("never marks claude 'active' — that would clobber its session id", () => {
    // `status-reporter` calls markAgentActive for EVERY agent on first
    // activity. Without the kind check, claude's pointer would be overwritten
    // with a timestamp, and the restart would resume nothing.
    markAgentActive('claude');
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('writes a timestamp for a presence-only agent', () => {
    markAgentActive('codex');
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fsMock.writeFileSync.mock.calls[0]?.[0]).toBe(AGENT_SESSION_POINTERS.codex?.path);
  });

  it('never records a session id against a presence-only agent', () => {
    recordAgentSessionId('codex', '0f9c2a11-dead-beef-0000-000000000000');
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('records a session id for claude, and rejects a malformed one', () => {
    recordAgentSessionId('claude', '0f9c2a11-dead-beef-0000-000000000000');
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    // A malformed payload must not write junk we would later hand to --resume.
    recordAgentSessionId('claude', '../../etc/passwd');
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all for an agent with no pointer', () => {
    markAgentActive('example');
    recordAgentSessionId('example', '0f9c2a11-dead-beef-0000-000000000000');
    clearAgentSessionPointer('example');
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });
});
