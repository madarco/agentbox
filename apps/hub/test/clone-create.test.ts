import { describe, expect, it } from 'vitest';
import { cloneCreateInput, type StagedClone } from '../lib/boxes/clone-create';

const staged: StagedClone = {
  ok: true,
  projectId: 'p1',
  workspace: '/home/vscode/.agentbox/clones/svc_clone',
  name: 'svc_clone',
  provider: 'docker',
  files: 12,
  sourceBoxId: 'src-1',
  carried: {},
};

describe('cloneCreateInput', () => {
  it('approves carry, so a project that declares one can still be cloned', () => {
    // `carry:` is a `required` prompt with no safe fallback, and a clone has no
    // human to ask — without this every clone of a project with a carry block is
    // refused. The grant is inherited, not invented: the source box was approved
    // for this same project's block.
    expect(cloneCreateInput(staged).opts?.carryYes).toBe(true);
  });

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

  it('runs the SERVICE agent the source box ran, when prepareClone named one', () => {
    // A bot's box is the bot: an agentless copy of an openclaw workspace is a
    // directory, not a second bot. `prepareClone` sets this only for a service
    // agent, so a claude box's clone still comes back agentless above.
    expect(cloneCreateInput({ ...staged, agent: 'openclaw' }).agent).toBe('openclaw');
  });

  it('forwards the resolved persistent, and only when the hub has an opinion', () => {
    expect(cloneCreateInput({ ...staged, persistent: true }).opts?.persistent).toBe(true);
    expect(cloneCreateInput({ ...staged, persistent: false }).opts?.persistent).toBe(false);
    // Absent, not `false`: sending `false` here would override the hub's own
    // box.persistent. (`opts` itself is always present now — it carries
    // `carryYes` — so this asserts the KEY, not the object.)
    expect(cloneCreateInput(staged).opts).not.toHaveProperty('persistent');
  });

  it('passes what the source box carried, with an explicit persistent winning', () => {
    const opts = cloneCreateInput({
      ...staged,
      persistent: false,
      carried: { skills: { none: true }, llmProxy: 'forward', persistent: true },
    }).opts;
    expect(opts).toMatchObject({ skills: { none: true }, llmProxy: 'forward', persistent: false });
  });
});

describe('a clone commits as the person who cloned it', () => {
  const ada = { name: 'Ada Lovelace', email: 'ada@example.com' };

  it("passes the requester's identity to the create", () => {
    // On a hub several people use, the hub default is the first PC enrolled:
    // without this, user B's clone commits as user A.
    expect(cloneCreateInput(staged, ada).opts?.gitIdentity).toEqual(ada);
  });

  it('sends none when the caller sent none (web, tray), so the hub default applies', () => {
    expect(cloneCreateInput(staged).opts).not.toHaveProperty('gitIdentity');
  });

  it('validates the identity at the route boundary', async () => {
    const { parseCloneBox } = await import('../app/(dashboard)/api/v1/lib/validate');
    expect(parseCloneBox({ gitIdentity: ada })).toEqual({ ok: true, value: { gitIdentity: ada } });
    const bad = parseCloneBox({ gitIdentity: { name: 'Ada\nLovelace', email: ada.email } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/gitIdentity\.name.*newlines/);
    expect(parseCloneBox({ gitIdentity: { name: 'Ada' } }).ok).toBe(false);
  });
});
