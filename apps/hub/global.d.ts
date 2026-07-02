import type { Store } from '@agentbox/relay';
import type { HubBackend } from './lib/boxes/backend-types';

declare global {
  // Set by the custom server (server.ts) after the relay daemon is constructed,
  // so Next server code shares the relay's live in-process Store (used by the
  // approvals/prompts view in a later phase).
  // eslint-disable-next-line no-var
  var __AGENTBOX_BOX_SOURCE: Store | undefined;

  // Host-facing backend (box list + lifecycle). Set by the custom server; Next's
  // source.ts / actions.ts reach the Node/docker toolchain only through this, so
  // it never enters Next's bundle. Implemented in lib/hub-backend.ts.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_BACKEND: HubBackend | undefined;

  // In-process fan-out for the live-updates SSE route (/api/events). Set by the
  // custom server to the relay's HubNotifier; fires whenever the pending-approval
  // set changes. Structural type keeps Next loosely coupled to the relay.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_NOTIFIER: { subscribe(fn: () => void): () => void } | undefined;
}

export {};
