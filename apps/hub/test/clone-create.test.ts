import { describe, expect, it } from 'vitest';
import { cloneCreateInput, type StagedClone } from '../lib/boxes/clone-create';

const staged: StagedClone = {
  ok: true,
  projectId: 'p1',
  workspace: '/home/vscode/.agentbox/clones/svc_clone',
  name: 'svc_clone',
  provider: 'docker',
  files: 12,
};

describe('cloneCreateInput', () => {
  it('enqueues the follow-on create in the FOREGROUND lane', () => {
    // The regression: the create moved from the CLI (which passed
    // `foreground: true`) into the route, which did not. A clone then queued
    // behind background `-i` jobs while its caller sat blocked on the job
    // stream — potentially forever.
    expect(cloneCreateInput(staged).foreground).toBe(true);
  });

  it('creates a box with no agent, named and projected from the staged clone', () => {
    expect(cloneCreateInput(staged)).toMatchObject({
      projectId: 'p1',
      provider: 'docker',
      agent: 'none',
      name: 'svc_clone',
    });
  });

  it('forwards the resolved persistent, and only when the hub has an opinion', () => {
    expect(cloneCreateInput({ ...staged, persistent: true }).opts).toEqual({ persistent: true });
    expect(cloneCreateInput({ ...staged, persistent: false }).opts).toEqual({ persistent: false });
    // Absent: sending `false` here would override the hub's own box.persistent.
    expect(cloneCreateInput(staged).opts).toBeUndefined();
  });
});
