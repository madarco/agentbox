import type { HubState } from './types';

// Result of a lifecycle server action.
export type ActionResult = { ok: true } | { ok: false; error: string };

// The host-facing backend. Implemented in lib/hub-backend.ts (Node-only, imports
// the sandbox/relay toolchain) and constructed by the custom server, which sets
// it on `globalThis.__AGENTBOX_HUB_BACKEND`. Next server code (source.ts /
// actions.ts) reaches it ONLY through that global, so the heavy Node/docker
// packages never enter Next's bundle. This is a pure-type module (no runtime
// imports) so both the implementation and the ambient global can share it.
export interface HubBackend {
  getData(): Promise<HubState>;
  pause(id: string): Promise<ActionResult>;
  resume(id: string): Promise<ActionResult>;
  stop(id: string): Promise<ActionResult>;
  destroy(id: string): Promise<ActionResult>;
}
