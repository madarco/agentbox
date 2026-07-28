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
  return {
    ok: true,
    request: {
      repoUrl,
      provider,
      ...(branch ? { branch } : {}),
      ...(name ? { name } : {}),
      ...(agent ? { agent } : {}),
      ...(prompt ? { prompt } : {}),
      // "Create a box" from the UI means a box with its agent running — the same
      // thing the local queue path does. The worker otherwise starts an agent only
      // when a seed prompt implies it, which would hand back a dead session.
      ...(noAgent ? {} : { startAgent: true }),
    },
  };
}
