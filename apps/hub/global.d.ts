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

  // Payload-carrying per-box prompt fan-out for the `/api/v1` prompt stream route
  // (the attach footer's channel). Set by the custom server from the relay handle's
  // PromptSubscribers/PendingPrompts/BoxNotices. `subscribe` registers a callback
  // for a box's `prompt-ask`/`prompt-resolved`/`notice-set`/`notice-clear` events
  // and returns an unsubscribe; `backlog` is the current pending prompts + active
  // notices, flushed to a newly-connected stream. Structural types only, so
  // @agentbox/relay never enters Next's bundle (see __AGENTBOX_HUB_CUSTODY).
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_PROMPTS:
    | {
        subscribe(boxId: string, listener: (event: string, data: unknown) => void): () => void;
        // The route only re-serializes these to SSE, so the element shape is left
        // opaque (the concrete PromptAskEvent/BoxNoticeEvent live in @agentbox/relay,
        // kept out of Next's bundle).
        backlog(boxId: string): {
          prompts: unknown[];
          notices: unknown[];
        };
      }
    | undefined;

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
        // What THIS machine hands to a box — present-only agent configs, skills
        // and identity files. Replaces the old `imageContextKeys`, which listed
        // agentbox's own baked assets and told a user nothing about their setup.
        hostCarried(): {
          agent: string;
          label: string;
          hostPath: string;
          kind: 'skills' | 'config' | 'identity';
          skills?: string[];
        }[];
        // Box-image resolution facts: which published tag this host asks for and
        // what it last stamped. The things a "why didn't it pull the prebuilt
        // image?" investigation otherwise reconstructs by hand.
        boxImage(): {
          registry: string;
          pullTag?: string;
          stampedFingerprint?: string;
          imageRef?: string;
          bakedAt?: string;
        } | null;
      }
    | undefined;
}

export {};
