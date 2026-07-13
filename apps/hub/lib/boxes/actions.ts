'use server';

import { revalidatePath } from 'next/cache';
import type { ActionResult, BoxOpResult, BranchList, BrowseDirResult, CreateBoxInput, CreateBoxResult } from './backend-types';

// Thin server actions. The lifecycle work runs in the Node-only backend on
// globalThis (set by the custom server); here we just dispatch and revalidate.
async function dispatch(op: 'pause' | 'resume' | 'stop' | 'destroy', id: string): Promise<ActionResult> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  const res = await backend[op](id);
  if (res.ok) revalidatePath('/', 'layout');
  return res;
}

export async function pauseBoxAction(id: string): Promise<ActionResult> {
  return dispatch('pause', id);
}
export async function resumeBoxAction(id: string): Promise<ActionResult> {
  return dispatch('resume', id);
}
export async function stopBoxAction(id: string): Promise<ActionResult> {
  return dispatch('stop', id);
}
export async function destroyBoxAction(id: string): Promise<ActionResult> {
  return dispatch('destroy', id);
}

// Rename a box: set its cosmetic display label (empty string clears it). Pure
// state — the container/branch/URL are untouched.
export async function renameBoxAction(id: string, displayName: string): Promise<ActionResult> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  const res = await backend.rename(id, displayName);
  if (res.ok) revalidatePath('/', 'layout');
  return res;
}

export async function answerApprovalAction(
  id: string,
  answer: 'y' | 'n',
  openedByClient?: boolean,
): Promise<ActionResult> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  const res = await backend.answerApproval(id, answer, openedByClient);
  if (res.ok) revalidatePath('/', 'layout');
  return res;
}

// Enqueue a background create job for a registered project. Returns the jobId so
// the UI can stream the per-job log; the box appears as `creating` immediately.
export async function createBoxAction(input: CreateBoxInput): Promise<CreateBoxResult> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  const res = await backend.create(input);
  if (res.ok) revalidatePath('/', 'layout');
  return res;
}

// Read-only: list a project's branches for the create-box base-branch picker.
// No revalidate (nothing mutates).
export async function listBranchesAction(projectId: string): Promise<BranchList> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  return backend.listBranches(projectId);
}

// Register a folder (absolute path) as a project so boxes can be created in it.
export async function addProjectAction(absPath: string): Promise<ActionResult> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  const res = await backend.addProject(absPath);
  if (res.ok) revalidatePath('/', 'layout');
  return res;
}

// Unregister a project (by id) from the hub. The backend refuses if it still has
// boxes; on success the project drops off the dashboard + sidebar.
export async function removeProjectAction(projectId: string): Promise<ActionResult> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  const res = await backend.removeProject(projectId);
  if (res.ok) revalidatePath('/', 'layout');
  return res;
}

// Read-only: list a directory on the hub host for the folder picker. No
// revalidate (nothing mutates).
export async function browseDirAction(dir?: string): Promise<BrowseDirResult> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  return backend.browseDir(dir);
}

// ── box git + service mutations (thin, over the same backend the REST API uses) ──
// revalidate on success so a branch change / restart is reflected in the next
// dashboard snapshot; the git + services panels also refresh via their own fetch.
async function opDispatch(fn: (backend: NonNullable<typeof globalThis.__AGENTBOX_HUB_BACKEND>) => Promise<BoxOpResult>): Promise<BoxOpResult> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  const res = await fn(backend);
  if (res.ok) revalidatePath('/', 'layout');
  return res;
}

export async function gitCheckoutAction(id: string, branch: string): Promise<BoxOpResult> {
  return opDispatch((b) => b.gitCheckout(id, branch));
}
export async function gitBranchAction(id: string, name: string, from?: string): Promise<BoxOpResult> {
  return opDispatch((b) => b.gitNewBranch(id, { name, from }));
}
export async function gitPushAction(id: string, input?: { remote?: string; force?: boolean }): Promise<BoxOpResult> {
  return opDispatch((b) => b.gitPush(id, input));
}
export async function gitPullAction(id: string, input?: { remote?: string; ffOnly?: boolean }): Promise<BoxOpResult> {
  return opDispatch((b) => b.gitPull(id, input));
}
export async function gitPushHostAction(id: string, input?: { as?: string; force?: boolean }): Promise<BoxOpResult> {
  return opDispatch((b) => b.gitPushHost(id, input));
}
export async function restartServiceAction(id: string, name?: string): Promise<ActionResult> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  const res = await backend.restartService(id, name);
  if (res.ok) revalidatePath('/', 'layout');
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
