/**
 * A complete AgentBox agent plugin, in one file.
 *
 * Deliberately plain JavaScript with no dependencies beyond node builtins —
 * not one `@agentbox/*` import. That is the claim this example exists to prove: an agent
 * package never enters AgentBox's build graph. Its data is a plain object that
 * `agentbox agent add` snapshots into `~/.agentbox/agents.json`, and its code is
 * reached through a variable `import()` of the entry path recorded there. A
 * plugin agent is therefore structurally exempt from the package cycle that
 * forces AgentBox's own agents to split data from behaviour.
 *
 * Register it with:
 *
 *     agentbox agent add ./examples/agentbox-agent-example
 *     agentbox agent list
 *
 * and remove it with `agentbox agent remove agentbox-agent-example`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** The agent API version this package targets. Gated at `agent add`. */
export const AGENT_API_VERSION = 1;

/** Where this agent keeps its config inside a box. */
const BOX_DIR = '/home/vscode/.agentbox-example-agent';

/**
 * THE DATA. Every field here is a string, array or plain object — the spec has
 * to stay JSON-serializable, because it is shipped into boxes whose baked
 * `agentbox-ctl` may predate the agent entirely (it arrives over the
 * `agents.list` RPC). That same property is what lets `agent add` snapshot it.
 *
 * This one runs a login shell, so it needs no network and cannot rot.
 */
export const agentSpec = {
  id: 'example-agent',
  /** Alternative spellings `agentbox <name>` should accept. */
  aliases: ['exagent'],
  /** tmux session name inside the box. */
  sessionName: 'example-agent',
  binary: 'bash',
  /**
   * HOW the agent gets into a box. `recipe` is the union — `npm`, `script`
   * (fetch-then-run, never `curl | bash`, so a blocked download fails the chain)
   * or `exec` for anything else. `runAs` is not a detail: an installer that
   * drops a binary in the invoking user's `~/.local/bin` must run as the box
   * user, while `npm install -g` needs root.
   *
   * This agent's binary is `bash`, which is already there, so the recipe is an
   * honest no-op and `postInstall` just creates the dirs it expects.
   */
  install: {
    recipe: { kind: 'exec', script: 'true' },
    runAs: 'root',
    postInstall: `install -d -o vscode -g vscode ${BOX_DIR}`,
  },
  /** Shared docker volume holding this agent's static config. */
  dockerVolume: 'agentbox-example-agent-config',
  /**
   * Host → box config sources. This is all the cloud providers need: every one
   * of them stages an agent's static config from these rows alone, so declaring
   * them is what gets this agent into every baked snapshot.
   */
  staticPaths: [{ hostHomeRel: ['.agentbox-example-agent'], boxDir: BOX_DIR }],
  /**
   * Where this agent's login lives — in the box, and in the host backup that
   * carries it between boxes. `hostBackup` must be a real absolute path under
   * `~/.agentbox`: the credential fan-out WRITES there when a box logs in, so
   * an empty string would drop a temp file in whatever directory the CLI
   * happened to be run from and lose the login.
   */
  credential: {
    boxRelPath: 'auth.json',
    boxAbsPath: `${BOX_DIR}/auth.json`,
    hostBackup: join(homedir(), '.agentbox', 'example-agent-credentials.json'),
    cloudMountPath: '/home/vscode/.agentbox-creds/example-agent',
    cloudSubpath: 'auth.json',
    realShape: 'nonempty-json',
  },
  /** Host env keys forwarded into the box so an env-authed agent finds creds. */
  forwardedEnvKeys: [],
  /** Extra env for the in-box process. */
  boxRunEnv: {},
  caps: {
    resume: false,
    teleport: 'stub',
    teleportStubReason: 'the example agent has no session to carry over.',
    /** Empty: ctl then skips probing rather than reporting a permanent `unknown`. */
    activitySource: [],
  },
  /**
   * Required once `staticPaths` is declared: an agent that can be pushed INTO a
   * box must say how it comes back out, or `agentbox download` silently does
   * nothing. Data, not code.
   */
  pull: { items: [{ group: 'data', names: ['auth.json'] }] },
};

/**
 * THE BEHAVIOUR, and it is optional — a data-only package is perfectly valid,
 * and everything declarative (listing, resolving, cloud staging) works without
 * this. It is only needed to create a DOCKER box for the agent, because that
 * requires knowing how to mount its config volume.
 */
export const agentSyncModule = {
  id: agentSpec.id,

  /** Which volume this box gets: shared, or per-box under `--isolate-*-config`. */
  resolveVolume: ({ isolate, boxId }) => ({
    volume: isolate ? `${agentSpec.dockerVolume}-${boxId}` : agentSpec.dockerVolume,
  }),

  /** How that volume is mounted into the container. */
  buildMounts: (spec) => ({
    extraVolumes: [`${spec.volume}:${BOX_DIR}`],
    env: {},
    volumeName: spec.volume,
  }),

  /**
   * Create/seed the volume. A real agent would rsync the host's config in here;
   * this one has nothing to copy, so it just reports what it did. `notes` is
   * how an agent says more than created/synced without the shared contract
   * growing a field only one agent can fill.
   */
  ensureVolume: () =>
    Promise.resolve({ created: true, synced: false, notes: ['example agent volume ready'] }),

  /** Is this agent's tmux session up? Probed by `agentbox list` / `status`. */
  sessionInfo: () =>
    Promise.resolve({ running: false, sessionName: agentSpec.sessionName, startedAt: null }),

  /** Optional post-sync step. Runs for EVERY agent, not just the built-in ones. */
  afterVolumeSync: () => Promise.resolve({ notes: ['example agent post-sync ran'] }),
};
