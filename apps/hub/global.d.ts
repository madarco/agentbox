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

  // The control box's custody store (agent creds / project seeds / bake records /
  // box SSH keys). Set by the custom server; the Custody + project-Seed routes
  // reach it through this (never values). `null` when custody is not enabled here
  // (no admin token — the localhost profile). Structural `list`/`get` only, so
  // @agentbox/relay's CustodyStore type never enters Next's bundle — a RUNTIME
  // import of it inside a route breaks the standalone build (turbopack emits a
  // mangled execa external that ERR_MODULE_NOT_FOUNDs), which is why the routes
  // reach the store via globalThis instead of constructing `new FsCustodyStore()`.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_CUSTODY:
    | {
        list(
          prefix?: string,
        ): Promise<
          { path: string; size: number; sha256: string; mode: number; updatedAt: string }[]
        >;
        get(path: string): Promise<{
          entry: { path: string; size: number; sha256: string; mode: number; updatedAt: string };
          data: Buffer;
        } | null>;
      }
    | null
    | undefined;

  // System / Build facts, read from @agentbox/sandbox-core in the custom server's
  // scope and handed across as PLAIN data. The System page's /api/v1/system route
  // uses this instead of importing @agentbox/sandbox-core directly — that package
  // depends on execa (serverExternalPackages), and a route-level runtime import of
  // it fails in the standalone build exactly like the custody store above. Set by
  // the custom server; `undefined` when unavailable (the plane / Postgres path),
  // where the route degrades gracefully.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_SYSTEM:
    | {
        // The provider's baked-base record (prepared-state), fingerprint already
        // shortened. Null when nothing is baked for it.
        preparedBase(provider: string): {
          fingerprint?: string;
          cliVersion?: string;
          bakedAt?: string;
          imageRef?: string;
        } | null;
        // The control-plane deploy record's display subset (+ its build `source`),
        // or null when this machine holds no deploy record.
        deployRecord(): {
          source?:
            | { kind: 'package'; spec: string }
            | { kind: 'source'; repoUrl: string; repoRef: string }
            | null;
          provider?: string;
          url?: string;
          publicUrl?: string;
          tunnel?: string;
          autostart?: boolean;
          port?: number;
          bind?: string;
        } | null;
        // The box-image build-context file keys (skills / agents / scripts baked in).
        imageContextKeys(): string[];
      }
    | undefined;
}

export {};
