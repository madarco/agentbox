import { verifyAgentSessionStaysUp } from '@agentbox/sandbox-cloud';
import { execInBox } from '@agentbox/sandbox-docker';

/**
 * The docker queued start's check that the agent's tmux session stayed up
 * (`tmux new-session -d` succeeds even when the agent exits at once).
 *
 * Stay-up only: no pane auth scan. Docker checks the agent's login before the
 * create, and the scan's markers (a bare `Unauthorized`) also match the agent's
 * own output, which would fail a job whose agent is working.
 */
export async function verifyDockerAgentSession(args: {
  container: string;
  boxName: string;
  sessionName: string;
  binary: string;
  windowMs?: number;
  pollMs?: number;
}): Promise<void> {
  await verifyAgentSessionStaysUp(
    (argv) => execInBox(args.container, argv, { user: 'vscode' }),
    args.boxName,
    args.sessionName,
    args.binary,
    { scanAuth: false, windowMs: args.windowMs, pollMs: args.pollMs },
  );
}
