import type { HubState } from './types';

// Result of a lifecycle server action.
export type ActionResult = { ok: true } | { ok: false; error: string };

// Input for creating a box in an existing (registered) project. The client
// sends a projectId (never a host path); the backend resolves it to the
// registered project's absolute path server-side. `agent` selects the coding
// agent to start detached in the box; `prompt` is an optional seed turn (empty
// = just start the agent, don't drive it).
export interface CreateBoxInput {
  projectId: string;
  // 'none' = just create the box (like `agentbox create`), don't start an agent.
  agent: 'claude' | 'codex' | 'opencode' | 'none';
  name?: string;
  prompt?: string;
}

// Create returns immediately with the background job id — the box is built by a
// detached queue worker; progress streams over the per-job log SSE.
export type CreateBoxResult = { ok: true; jobId: string } | { ok: false; error: string };

// One subdirectory in the server-side folder browser. `isProject` flags a folder
// that already looks like a project root (has a .git or agentbox.yaml) so the UI
// can hint which folders are ready to host a box.
export interface DirEntry {
  name: string;
  path: string;
  isProject: boolean;
}

// Listing of one directory on the hub host: the resolved absolute path, its
// parent (null at the filesystem root), and its immediate subdirectories.
export type BrowseDirResult =
  | { ok: true; path: string; parent: string | null; entries: DirEntry[] }
  | { ok: false; error: string };

// Minimal job view for the log-stream route: the log file to tail, the terminal
// status (so the SSE knows when to stop), and the box id once the worker writes
// it back. Status is a plain string to keep this module free of relay imports.
export interface JobView {
  status: string;
  logPath: string;
  boxId?: string;
}

// The host-facing backend. Implemented in lib/hub-backend.ts (Node-only, imports
// the sandbox/relay toolchain) and constructed by the custom server, which sets
// it on `globalThis.__AGENTBOX_HUB_BACKEND`. Next server code (source.ts /
// actions.ts) reaches it ONLY through that global, so the heavy Node/docker
// packages never enter Next's bundle. This is a pure-type module (no runtime
// imports) so both the implementation and the ambient global can share it.
export interface HubBackend {
  // authMode is an env-derived concern layered on by source.ts, not the host
  // backend — so the backend produces everything else.
  getData(): Promise<Omit<HubState, 'authMode'>>;
  pause(id: string): Promise<ActionResult>;
  resume(id: string): Promise<ActionResult>;
  stop(id: string): Promise<ActionResult>;
  destroy(id: string): Promise<ActionResult>;
  // Answer a pending host-action approval; resolves the parked in-box RPC.
  answerApproval(id: string, answer: 'y' | 'n'): Promise<ActionResult>;
  // Enqueue a background create job for a registered project; returns the jobId.
  create(input: CreateBoxInput): Promise<CreateBoxResult>;
  // Register a folder (absolute path) as a project so it can host boxes.
  addProject(absPath: string): Promise<ActionResult>;
  // Unregister a project by id (hash). Refuses if the project still has boxes or
  // in-flight create jobs — only an empty project can be removed.
  removeProject(projectId: string): Promise<ActionResult>;
  // List a directory on the hub host for the folder picker. `dir` defaults to the
  // user's home; entries are the immediate subdirectories.
  browseDir(dir?: string): Promise<BrowseDirResult>;
  // Read a background job (log path + status) for the per-job log SSE. null when
  // the manifest is gone.
  getJob(id: string): Promise<JobView | null>;
}
