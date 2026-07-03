'use server';

import { revalidatePath } from 'next/cache';
import type { ActionResult, BrowseDirResult, CreateBoxInput, CreateBoxResult } from './backend-types';

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

export async function answerApprovalAction(id: string, answer: 'y' | 'n'): Promise<ActionResult> {
  const backend = globalThis.__AGENTBOX_HUB_BACKEND;
  if (!backend) return { ok: false, error: 'hub backend unavailable (run the hub server)' };
  const res = await backend.answerApproval(id, answer);
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
