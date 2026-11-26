import type { ActivityStore, Store } from '@agentbox/relay';
import type { HubBackend } from './lib/boxes/backend-types';
import type { DeviceService } from './lib/backend/devices';
import type { HistoryService } from './lib/backend/history';
import type { MemoryService } from './lib/backend/history-memory';
import type { SkillProposals } from './lib/backend/skill-proposals';
import type { ShareStore } from './lib/backend/usage-share';

declare global {
  // Set by the custom server (server.ts) after the relay daemon is constructed,
  // so Next server code shares the relay's live in-process Store (used by the
  // approvals/prompts view in a later phase).
  // eslint-disable-next-line no-var
  var __AGENTBOX_BOX_SOURCE: Store | undefined;

  // Enrolled devices + the enrollment codes (multi-PC Phase 1b). Set by the custom
  // server on a password profile only; the `/api/v1/devices` routes answer 503
  // without it. Never constructed inside Next: the repo is `node:sqlite`.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_DEVICES: DeviceService | undefined;

  // Session history ingest (docs/agent-history-plan.md). Built by the custom
  // server on `node:sqlite`; the /api/v1/history routes reach it through here.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_HISTORY: HistoryService | undefined;

  // The activity ledger (usage dashboard Phase 1), opened by the custom server;
  // `/api/v1/activity` reads it through here, since Next bundles its own copy
  // of `@agentbox/relay` and would not see the server's installed ledger.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_ACTIVITY: ActivityStore | undefined;

  // The usage shares this hub made (share.json). One per process: the share routes
  // may be bundled with separate copies of the store module.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_SHARE_STORE: ShareStore | undefined;

  // Agent memory versions (docs/agent-history-plan.md, Phase 4), in history.db.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_MEMORY: MemoryService | undefined;
  // The MCP server for hub-credential callers (`POST /api/mcp`), set by the
  // custom server; boxes reach the same server through the relay.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_MCP:
    | { handle(message: unknown, opts?: { skillBytes?: boolean }): Promise<unknown> }
    | undefined;

  // Skill proposals from boxes (docs/hub-skills-plan.md, Phase 7), set by the
  // custom server: it holds the relay's prompt mailbox the approval waits in.
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_SKILL_PROPOSALS: SkillProposals | undefined;

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
          /** Latest box-status snapshot, when one has been received. */
          status?: unknown;
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
        // Write verbs for the `/api/v1/custody/[...path]` route (the CLI's
        // `credentials/secrets/custody/project push` + `rm`, and the tray/web).
        // `put` is content-addressed (returns `changed: false` when the bytes were
        // already there); neither ever returns the stored value of another entry.
        put(
          path: string,
          data: Buffer,
        ): Promise<{
          path: string;
          size: number;
          sha256: string;
          mode: number;
          updatedAt: string;
          changed: boolean;
        }>;
        delete(path: string): Promise<boolean>;
        // Streaming counterparts, for payloads too large to buffer as base64
        // inside a JSON envelope (a project's `carry:` material). `Readable` is
        // spelled structurally so this file needs no node:stream import.
        putStream(
          path: string,
          body: NodeJS.ReadableStream,
          opts?: { maxBytes?: number },
        ): Promise<{
          path: string;
          size: number;
          sha256: string;
          mode: number;
          updatedAt: string;
          changed: boolean;
        }>;
        getStream(path: string): Promise<{
          entry: { path: string; size: number; sha256: string; mode: number; updatedAt: string };
          data: NodeJS.ReadableStream;
        } | null>;
      }
    | null
    | undefined;

  /** Streaming-blob cap the hub enforces (`AGENTBOX_CUSTODY_MAX_BLOB_BYTES`). */
  // eslint-disable-next-line no-var
  var __AGENTBOX_HUB_CUSTODY_MAX_BLOB_BYTES: number | undefined;

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
        // The agents a picker should offer, and whether this machine is set up
        // for each (host config dir or a saved AgentBox login). Registry-driven,
        // so it includes agents registered by `agentbox agent add`.
        // `surface` says what shape the agent is: a 'tui' agent is a session you
        // attach to, a 'service' agent is a daemon a box hosts. A picker that
        // launches an interactive session (the manager) must exclude 'service'.
        agents(): {
          id: string;
          label: string;
          installed: boolean;
          surface?: 'tui' | 'service';
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
