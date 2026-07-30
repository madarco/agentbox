// Turn a hub web-UI create into a control-plane create-job request.
//
// The UI's create normally enqueues a local queue job that builds a box from a
// host working copy. A control box has none — its projects are repos, not
// folders — so those creates go to the control-plane queue instead, the one path
// that leases a push token, clones the repo and overlays the custody seed.
//
// Kept pure (no fs, no store) so the mapping is testable; the caller supplies the
// repo URL it resolved and does the enqueueing.
import type { CreateJobRequest } from '@agentbox/relay/control-plane';

export interface ControlPlaneCreateInput {
  provider?: string;
  agent?: string;
  name?: string;
  prompt?: string;
  fromBranch?: string;
  // Fully-processed agent argv (post-`--`, incl. skip-permissions). Carried so a
  // hub-routed `-i` run keeps the same args a local one does; the old mapping
  // silently dropped this, so e.g. --dangerously-skip-permissions stopped working.
  agentArgs?: string[];
  // Start the agent even without a seed prompt (web-UI "create a box").
  startAgent?: boolean;
}

export type ControlPlaneCreateMapping =
  | { ok: true; request: CreateJobRequest }
  | { ok: false; error: string };

/**
 * A docker box bind-mounts a host folder, so it can only ever be built where that
 * folder is. On a control box there is no such folder — the request is a mistake
 * worth naming rather than a clone to attempt.
 */
function isDocker(provider: string): boolean {
  return provider === 'docker' || provider.startsWith('docker:');
}

export function controlPlaneCreateRequest(
  input: ControlPlaneCreateInput,
  repoUrl: string,
): ControlPlaneCreateMapping {
  const provider = (input.provider ?? 'docker').trim();
  if (isDocker(provider)) {
    return {
      ok: false,
      error: 'docker boxes need a local checkout — pick a cloud provider for a hub-created box',
    };
  }
  const noAgent = input.agent === 'none';
  const agent = noAgent ? undefined : (input.agent ?? 'claude');
  const branch = input.fromBranch?.trim();
  const name = input.name?.trim();
  const prompt = noAgent ? undefined : input.prompt?.trim();
  const agentArgs = noAgent ? undefined : input.agentArgs;
  // Start the agent in-box by default when there is one (the web-UI "create a
  // box" means a box with its agent running — otherwise it hands back a dead
  // session). A foreground `createCloudBoxViaHubAndAdopt` builds a COLD box
  // (startAgent:false) because the PC adopts it and the agent launches on attach.
  const startAgent = noAgent ? false : input.startAgent !== false;
  return {
    ok: true,
    request: {
      repoUrl,
      provider,
      ...(branch ? { branch } : {}),
      ...(name ? { name } : {}),
      ...(agent ? { agent } : {}),
      ...(prompt ? { prompt } : {}),
      // The processed agent argv (skip-permissions etc.) must survive to the
      // worker — dropping it here silently broke those flags on the hub path.
      ...(agentArgs && agentArgs.length > 0 ? { agentArgs } : {}),
      ...(startAgent ? { startAgent: true } : {}),
    },
  };
}
