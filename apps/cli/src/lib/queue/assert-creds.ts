/**
 * The `-i` pre-flight: refuse to submit a detached job whose agent has no
 * host-side credentials to seed into the box.
 *
 * This file names no agent. It used to hold each one's host check and dispatch
 * between them with `agent === 'codex' ? … : opencode` — so a fourth agent
 * silently got OpenCode's credential check and a wrong answer. The check is the
 * agent's own now (`AgentRuntime.hostCredStatus`, implemented in
 * `agents/<id>/host-creds.ts`); what stays here is the contract, the errors and
 * the wording, which already had a generic fallback for an agent it had never
 * heard of.
 */
import type { QueueAgentKind } from '@agentbox/relay';
import { normalizeLastAgent } from '@agentbox/core';
import type { HostCredVerdict } from '@agentbox/cli-kit';

export type { HostCredVerdict };

/**
 * Wording for the agents we have something specific to say about. Not total —
 * see {@link missingCredsMessage}.
 */
const MESSAGES: Record<string, string> = {
  'claude-code':
    'No Claude credentials on host. Run `agentbox claude login` first (or `agentbox claude` interactively) to seed them, then retry.',
  codex:
    'No Codex credentials on host. Run `agentbox codex login` first (or set OPENAI_API_KEY) to seed them, then retry.',
  opencode:
    'No OpenCode credentials on host. Run `agentbox opencode login` first to seed them, then retry.',
};

/**
 * The specific message where we have one, a generic one otherwise. With
 * `QueueAgentKind` open, indexing {@link MESSAGES} is no longer total, and an
 * agent with no entry deserves usable wording rather than `undefined`.
 */
function missingCredsMessage(agent: QueueAgentKind): string {
  const id = normalizeLastAgent(agent) ?? agent;
  return (
    MESSAGES[agent] ??
    `No ${id} credentials on host. Run \`agentbox ${id} login\` first to seed them, then retry.`
  );
}

export class MissingAgentCredsError extends Error {
  readonly agent: QueueAgentKind;
  constructor(agent: QueueAgentKind, message: string) {
    super(message);
    this.name = 'MissingAgentCredsError';
    this.agent = agent;
  }
}

/**
 * Subclass for the present-but-expired case (Claude on cloud). Extends
 * {@link MissingAgentCredsError} so the existing `instanceof MissingAgentCredsError`
 * catches at the call sites still match (→ same fail-fast / exit 2), while callers
 * and tests can distinguish the reason.
 */
export class ExpiredAgentCredsError extends MissingAgentCredsError {
  constructor(agent: QueueAgentKind, message: string) {
    super(agent, message);
    this.name = 'ExpiredAgentCredsError';
  }
}

/**
 * An agent's verdict on its own host credentials. `'expired'` is for the
 * present-but-unrenewable case; an agent with no such concept simply never
 * returns it.
 */


export interface AssertAgentCredsInput {
  agent: QueueAgentKind;
  image: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Provider for this run. Passed to the agent's own check as `isCloud`, which
   * claude uses to gate its renewability probe — cloud has no shared volume to
   * fall back on. Omitted/`'docker'` → presence check only.
   */
  providerName?: string;
  /**
   * The agent's own host-credential check. Required: there is no default, so an
   * agent that has not supplied one is a compile error rather than a silent
   * pass — which is what the removed three-arm chain gave a fourth agent.
   */
  hostCredStatus: (o: {
    image: string;
    env: NodeJS.ProcessEnv;
    isCloud: boolean;
  }) => Promise<HostCredVerdict>;
}

/**
 * Pre-flight for the background `-i` path: throw `MissingAgentCredsError`
 * when the chosen agent has no host-side credentials to seed into the box.
 * The worker (`_run-queued-job.ts`) runs in detached mode with no attach, so
 * an unauthenticated in-box agent would silently sit on its `/login` UI with
 * the user's prompt unprocessed until the user re-attaches — that is the UX
 * this guard prevents.
 */
export async function assertAgentCredsAvailable(input: AssertAgentCredsInput): Promise<void> {
  const env = input.env ?? process.env;
  const isCloud = input.providerName !== undefined && input.providerName !== 'docker';
  const verdict = await input.hostCredStatus({ image: input.image, env, isCloud });
  if (verdict.status === 'ok') return;
  if (verdict.status === 'expired') {
    throw new ExpiredAgentCredsError(input.agent, verdict.message);
  }
  throw new MissingAgentCredsError(input.agent, missingCredsMessage(input.agent));
}
