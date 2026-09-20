// Hand-authored OpenAPI 3.1 document for the public API. Kept in lock-step with the
// route handlers + validators by hand (the repo has no zod/codegen convention); the
// verification checklist asserts every route appears here. Served verbatim at
// GET /api/v1/openapi.json; GET /api/v1/docs renders it with Scalar.

const errorResponse = {
  description: 'Error',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
};

const managerIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[0-9a-f]{16}$' },
  description: 'Manager id.',
};

const workspaceIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Workspace id.',
};

const detectSchema = {
  type: 'object',
  properties: {
    manager: { $ref: '#/components/schemas/Manager' },
    workspace: { $ref: '#/components/schemas/Workspace' },
  },
  required: ['manager', 'workspace'],
};

const NOTE_DESCRIPTION =
  "Why: recorded on the workspace timeline as a `manager.note` next to this change (stamped with the caller's manager and turn when the CLI sends `X-AgentBox-Session`).";

const timelineEventTypes = [
  'task.created',
  'task.status',
  'task.assigned',
  'task.unassigned',
  'task.removed',
  'manager.joined',
  'manager.started',
  'manager.resumed',
  'manager.stopped',
  'manager.note',
  'manager.message',
  'box.created',
  'box.ready',
  'box.failed',
  'box.started',
  'box.stopped',
  'box.destroyed',
  'box.branch',
  'git.push',
  'pr.opened',
  'pr.ready',
  'pr.merged',
  'pr.closed',
];

const taskStatusEnum = { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] };

const timelineEventProperties = {
  id: {
    type: 'string',
    description: 'Time-sortable: zero-padded base-36 ms, then a random suffix.',
  },
  at: { type: 'string', description: 'ISO time.' },
  type: { type: 'string', enum: timelineEventTypes },
  actor: { type: 'string', enum: ['human', 'manager', 'box', 'hub', 'github'] },
  managerId: { type: 'string' },
  turn: {
    type: 'number',
    description:
      "The manager session's turn when this happened; only when its transcript is on the hub's disk.",
  },
  prompt: { type: 'string', description: "That turn's prompt, as a one-line title." },
  boxId: { type: 'string' },
  boxName: { type: 'string' },
  agent: { type: 'string' },
  branch: {
    type: 'string',
    description:
      '`box.branch`: the branch the box is on after the switch, as the hub sanctioned it.',
  },
  base: {
    type: 'string',
    description:
      "`box.created`: the branch the box forked from (the create's `fromBranch`, else the branch the project's host checkout was on; absent when unknown). `box.ready`: the create's `fromBranch`, only when it had one. `box.branch`: the branch it switched away from.",
  },
  projectId: { type: 'string' },
  taskIds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Captured when the event was written (a task later leaves its box).',
  },
  task: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      from: taskStatusEnum,
      to: taskStatusEnum,
    },
    required: ['id', 'title'],
  },
  pr: { $ref: '#/components/schemas/TimelinePr' },
  text: { type: 'string', description: 'A note, or the message sent to a manager.' },
  noteKind: { type: 'string', enum: ['note', 'replan', 'plan'] },
  boxRunning: {
    type: 'boolean',
    description: '`task.assigned`: the box was already running (it was given more work).',
  },
  additions: {
    type: 'number',
    description:
      '`git.push`: lines the push added, read from the host repo when it was recorded (the old tip to the new, or the merge base with the default branch for a first push or a force-push that rewrote the old tip). Absent when it could not be read.',
  },
  deletions: {
    type: 'number',
    description: '`git.push`: lines the push removed (see `additions`).',
  },
  key: {
    type: 'string',
    description:
      'Dedupe key (`pr:<repo>#<n>:merged`, `job:<jobId>:ready`); an event whose key is already logged is not appended again.',
  },
};

/** `id` is minted by the store, so a forwarded event never carries one. */
const timelineEventInputProperties = Object.fromEntries(
  Object.entries(timelineEventProperties).filter(([k]) => k !== 'id'),
);

export function buildOpenApi(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentBox Hub API',
      version: '1.0.0',
      description:
        'Launch and manage AgentBox sandboxes ("boxes") programmatically. Every endpoint except /health, /openapi.json and /docs requires an Authorization: Bearer <hub token> header (the token the hub prints on boot, also at ~/.agentbox/hub/token). Errors always return { error: { code, message, details? } }.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'System', description: 'Liveness and API version.' },
      { name: 'Boxes', description: 'Create, inspect, and run lifecycle actions on boxes.' },
      { name: 'Box git', description: "Git state and operations on a box's branch." },
      { name: 'Box services', description: "A box's agentbox.yaml service/task/port status." },
      { name: 'Projects', description: 'Register folders as projects and list their branches.' },
      {
        name: 'Providers',
        description: 'Sandbox providers: status, credentials, base-image bake.',
      },
      {
        name: 'Agents',
        description: 'Coding agents this hub can start, and host setup for each.',
      },
      { name: 'Hosts', description: 'Remote-docker host aliases (name -> SSH connection).' },
      { name: 'Approvals', description: 'Pending host-action approvals.' },
      { name: 'Jobs', description: 'Async create/bake job status and log streams.' },
      {
        name: 'Checkpoints',
        description: 'Durable per-project checkpoints (docker image / cloud snapshot).',
      },
      {
        name: 'Fleet',
        description: 'Fleet-wide maintenance (prune orphan boxes and resources).',
      },
      {
        name: 'Custody',
        description: 'What the control box holds in custody (metadata only — never values).',
      },
      {
        name: 'Workspaces',
        description:
          'Folders grouping one or more projects, each owning a task list and its manager sessions.',
      },
      {
        name: 'Tasks',
        description: 'Units of work, prioritized by list order and assigned to boxes.',
      },
      {
        name: 'Managers',
        description:
          'Host agent sessions that create and watch boxes: detected from your terminal, or run by the hub in tmux.',
      },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Get liveness + API version',
          security: [],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
            },
          },
        },
      },
      '/boxes': {
        get: {
          tags: ['Boxes'],
          summary: 'List or resolve boxes',
          description:
            'Lists every box (normalized view). ?live=1 refreshes each cloud box state with an SDK probe (opt-in, slower; host topology only). ?ref=<id|name|index> instead resolves a single box server-side (findBox semantics: exact id, unique id prefix, name, displayName, sandbox id); pass ?project=<host-path> for numeric project-index refs. The ref response is the match set in { boxes }: 0 (none), 1 (unique), or >1 (ambiguous prefix).',
          parameters: [
            { name: 'live', in: 'query', required: false, schema: { type: 'string', enum: ['1'] } },
            { name: 'ref', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'project', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Boxes',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      boxes: { type: 'array', items: { $ref: '#/components/schemas/Box' } },
                    },
                    required: ['boxes'],
                  },
                },
              },
            },
            '401': errorResponse,
          },
        },
        post: {
          tags: ['Boxes'],
          summary: 'Create a box',
          description:
            'Async — returns a job id. agent "none" just creates the box without starting an agent (prompt ignored). provider defaults to docker; a cloud provider must be configured on the host (see GET /providers). A SERVICE agent (one whose GET /agents row reports `surface: "service"`, e.g. openclaw) creates a PERSISTENT box by default — it hosts a daemon, so an autopause would be an outage; pass `opts.persistent: false` for an expendable one. A persistent create on e2b/vercel is refused with `conflict` rather than silently downgraded. A service-agent box has no session to attach to: the build ends at a running daemon.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateBox' } } },
          },
          responses: {
            '202': {
              description: 'Accepted — build job enqueued',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { jobId: { type: 'string' } },
                    required: ['jobId'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}': {
        get: {
          tags: ['Boxes'],
          summary: 'Get one box',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Box',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Box' } } },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/boxes/{id}/{action}': {
        post: {
          tags: ['Boxes'],
          summary: 'Run a lifecycle action',
          description:
            'One of start | pause | resume | stop | destroy | screen. start brings a stopped box back up (resumes if paused, no-op if already running); it does not restart the agent session — that happens on the next attach. screen is the open-VNC prep step: it points the in-box browser at the box’s web app so the VNC desktop shows the app instead of a blank X screen — call it right before opening the viewer. It does not return a URL; get that from GET /boxes/{id}/vnc.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'action',
              in: 'path',
              required: true,
              schema: {
                type: 'string',
                enum: ['start', 'pause', 'resume', 'stop', 'destroy', 'screen'],
              },
            },
          ],
          responses: {
            '200': {
              description: 'Done',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/git': {
        get: {
          tags: ['Box git'],
          summary: "Get the box's live git summary",
          description: "The worktree's current branch, dirty, ahead/behind.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Git info',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/GitInfo' } } },
            },
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/git/{op}': {
        post: {
          tags: ['Box git'],
          summary: 'Run a git op on the box branch',
          description:
            'checkout {branch}; branch {name, from?} (create+switch a new agentbox/* branch); pull {remote?, ffOnly?}; push {remote?, force?}; push-host {as?, force?} (land in the host repo only, publishes nothing).',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'op',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['checkout', 'branch', 'pull', 'push', 'push-host'] },
            },
          ],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/GitOpBody' } } },
          },
          responses: {
            '200': {
              description: 'Done (git stdout/stderr)',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/GitOpResult' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/branches': {
        get: {
          tags: ['Box git'],
          summary: "List the box project's branches",
          description:
            'Local + remote branches and the current HEAD, for the box git-panel branch picker.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Branches',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/BranchList' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/services': {
        get: {
          tags: ['Box services'],
          summary: "Get the box's service/task/port status",
          description:
            "From the box's agentbox.yaml — live, or the persisted snapshot when the box isn't running.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Services',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Services' } },
              },
            },
            '401': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/services/restart': {
        post: {
          tags: ['Box services'],
          summary: 'Restart services',
          description: 'Restart one service (body {name}) or every service (empty body).',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { name: { type: 'string' } } },
              },
            },
          },
          responses: {
            '200': {
              description: 'Restarted',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/vnc': {
        get: {
          tags: ['Boxes'],
          summary: "Mint the box's noVNC viewer URL",
          description:
            "A ready-to-open noVNC URL (autoconnect, password in the query). Cloud boxes get a freshly SIGNED preview URL on port 6080 that expires — which is why the Box payload's `vncUrl` is null for daytona/vercel/e2b and this must be called at click time. Docker/hetzner boxes return their stable Portless/OrbStack/loopback URL. Read-only: refused with 409 when the box is not running, has VNC disabled, or has no recorded password. Pair with POST /boxes/{id}/screen to point the in-box browser at the web app first.",
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'ttl',
              in: 'query',
              required: false,
              description: 'Cloud only: signed-URL lifetime in seconds (provider default 3600).',
              schema: { type: 'integer', minimum: 1, maximum: 86400 },
            },
            {
              name: 'loopback',
              in: 'query',
              required: false,
              description:
                'Docker only: prefer the 127.0.0.1 host-port URL over OrbStack/Portless.',
              schema: { type: 'string', enum: ['1'] },
            },
          ],
          responses: {
            '200': {
              description: 'Viewer URL',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { url: { type: 'string' }, ttl: { type: 'integer' } },
                    required: ['url'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/web': {
        get: {
          tags: ['Boxes'],
          summary: "Resolve a box's web URL at click time, with a sign-in link when one applies",
          description:
            "The live web URL for the box, plus — for a SERVICE agent (openclaw) — a link that opens the agent's own UI already signed in. Call this before opening a box's web UI instead of using the Box payload's `webUrl`: that field is a recorded value, and where the URL is an SSH forward (hetzner/DO) the live port differs once the session has been re-established — the same class of reason `vncUrl` is null for signed-URL clouds. `signInUrl` is `<url>/#token=…` (the daemon generates its token inside the box and its UI reads it from the URL FRAGMENT), and null when the agent declares no such field or has not written one yet. `signInPending` tells those two apart: true means this box's daemon HAS a token and could not give one (still starting, or still onboarding), so `url` opens its sign-in prompt at best and a dead port at worst — say \"not ready yet\" and offer to wait rather than opening it. False means `url` is the complete answer. Read-only: refused with 409 when the box is not running.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Web URL, and the sign-in link when there is one',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      url: { type: 'string' },
                      signInUrl: { type: 'string', nullable: true },
                      signInPending: { type: 'boolean' },
                    },
                    required: ['url', 'signInUrl', 'signInPending'],
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/rename': {
        post: {
          tags: ['Boxes'],
          summary: "Set or clear a box's display label",
          description:
            'Cosmetic only — the container, branch and URLs are untouched. Pass an empty string to clear the label. Backs `agentbox status <box> --set-name/--clear-name`.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    displayName: {
                      type: 'string',
                      description: 'New label (max 60 chars); empty string clears it.',
                    },
                  },
                  required: ['displayName'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Renamed',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/agent': {
        get: {
          tags: ['Boxes'],
          summary: "Get the box's in-box coding-agent status snapshot",
          description:
            "Every reporting agent's live activity (working / idle / waiting / question / end-plan / …), plan/question payload and session title, from the persisted status store. Backs `agentbox agent state/wait-for/get-plan-question`.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Agent state',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/AgentState' } },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/logs': {
        get: {
          tags: ['Boxes'],
          summary: "Read (or follow) a box's service log",
          description:
            'One of two shapes on one route. `follow=0` (default) returns a JSON `{ output }` snapshot — a bounded `--tail` dump. `follow=1` returns an SSE stream (`open` / `log`* / `end`) the hub pipes live from the in-box `agentbox-ctl logs --follow`. Pass `service=<name>` for a declared service, or `daemon=1` for the ctl-daemon log.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'service',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'A declared service name (required unless daemon=1).',
            },
            {
              name: 'daemon',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['1'] },
              description: 'Tail the ctl-daemon log instead of a service.',
            },
            {
              name: 'follow',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['1'] },
              description: 'Stream the log as SSE instead of returning a snapshot.',
            },
            {
              name: 'tail',
              in: 'query',
              required: false,
              schema: { type: 'integer' },
              description: 'Lines of history (default 200).',
            },
          ],
          responses: {
            '200': {
              description: 'Log snapshot (JSON) or SSE stream (text/event-stream when follow=1)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { output: { type: 'string' } },
                    required: ['output'],
                  },
                },
                'text/event-stream': { schema: { type: 'string' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/checkpoint': {
        post: {
          tags: ['Checkpoints'],
          summary: 'Capture the box state as a project checkpoint',
          description:
            'Commits the box (docker commit / cloud snapshot) into the project checkpoint store on the hub machine, via provider.checkpoint.*. A durable project asset — it survives the box. Backs `agentbox checkpoint create`.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description: 'Checkpoint name (auto-generated if omitted).',
                    },
                    merged: {
                      type: 'boolean',
                      description: 'docker: flatten to a single squashed layer (FROM scratch).',
                    },
                    setDefault: {
                      type: 'boolean',
                      description: "Also pin this as the project's default checkpoint.",
                    },
                    replace: {
                      type: 'boolean',
                      description: 'Overwrite an existing checkpoint of the same name.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Checkpoint captured',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CheckpointCreateResult' },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/backup': {
        post: {
          tags: ['Checkpoints'],
          summary: "Capture a bot: workspace + the agent's state dir, identity included",
          description:
            "Writes `<project>/.agentbox/bots/<bot>/<stamp>/` on the HUB's machine — a `workspace/` half, and (when the box's agent declares a state backup, i.e. `supportsBackup` on the box payload) a `state/` half holding the bot's IDENTITY: gateway token, channel pairings, history. Live databases go through SQLite's online-backup API, not a byte copy. Unlike a checkpoint, this is provider-neutral files, so a bot captured on e2b restores onto hetzner. The state half is BEST-EFFORT — a box whose agent cannot be reached still yields a usable workspace bundle, and the manifest's `state: false` says so. Mirrors `agentbox download --backup`; read back by `POST /projects/{id}/restore`. `state/` holds a live credential: it is written 0700 and `.agentbox/` is added to the project's .gitignore.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description:
                        'Bot name the bundle is filed under (default: the box name). A single path segment.',
                    },
                    keep: {
                      type: 'integer',
                      minimum: 1,
                      description:
                        'Backups to keep for this bot; older ones are pruned. Default 3.',
                    },
                    agent: {
                      type: 'string',
                      description:
                        "Whose state to capture (default: the box's own recorded agent).",
                    },
                    includeNodeModules: {
                      type: 'boolean',
                      description: 'Carry node_modules into the workspace half as well.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Backup written',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      bot: { type: 'string' },
                      stamp: { type: 'string' },
                      dir: {
                        type: 'string',
                        description: "Absolute bundle dir on the HUB's machine.",
                      },
                      agent: { type: 'string' },
                      state: {
                        type: 'boolean',
                        description:
                          'False when only the workspace was captured — no identity in this bundle.',
                      },
                      databases: { type: 'array', items: { type: 'string' } },
                      files: { type: 'number' },
                      pruned: { type: 'array', items: { type: 'string' } },
                      wroteGitignore: { type: 'boolean' },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/upload': {
        post: {
          tags: ['Box services'],
          summary: 'Push the host workspace into the box (`agentbox upload`)',
          description:
            "The host->box direction, the mirror of `agentbox download`. A git workspace merges the host branch into the box branch and overlays the host's uncommitted/untracked changes; a non-git workspace gets a plain file overlay. THE BOX WINS every conflict — nothing in the box is overwritten or reset, and the skipped host paths come back in `conflicts`. Needs the in-process host backend, and reads the workspace off the HUB'S OWN disk — a client on another machine cannot push its files this way, so `agentbox upload` refuses rather than uploading the hub's copy of the project.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    includeNodeModules: {
                      type: 'boolean',
                      description: 'Push node_modules too (non-git workspaces only).',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Workspace synced',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      mode: { type: 'string', enum: ['git', 'files'] },
                      copied: { type: 'integer' },
                      conflicts: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['mode', 'copied', 'conflicts'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/clone': {
        post: {
          tags: ['Boxes'],
          summary: "New box from this box's workspace, with a fresh agent identity",
          description:
            "Exports the box's workspace files (gitignore/exclude aware, agent state dropped) into a new host project dir, then enqueues a normal create seeded from it. The agent's config volume and credential are deliberately NOT copied, so the clone onboards from scratch and gets its own identity — there is no `--with-state`. `.git` is not exported: the clone is a template, and a git-backed second box is what a plain create already gives you. Returns the create job; stream it via GET /jobs/{jobId}/logs — the create is enqueued in the ungated FOREGROUND lane, because the caller is blocked on that stream and must not queue behind background jobs. Backs `agentbox clone`.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description: 'Name for the new box (default `<source>-clone`).',
                    },
                    provider: {
                      type: 'string',
                      description: "Provider for the new box (default: the source box's).",
                    },
                    into: {
                      type: 'string',
                      description:
                        "Dir for the clone's workspace ON THE HUB'S MACHINE (default `~/.agentbox/clones/<name>`, in the hub user's home); must be absent or empty. MUST BE ABSOLUTE — a working directory is client state that does not travel over an API, so a relative path is rejected with `invalid_request` rather than resolved against whatever directory the hub daemon was started in. `agentbox clone --into` resolves it against your cwd before sending.",
                    },
                    includeNodeModules: { type: 'boolean' },
                    persistent: {
                      type: 'boolean',
                      description:
                        "Always-on clone. OMIT to inherit the source box's persistence (a clone of a service box is always-on too); `false` is an explicit opt-out. `true` against e2b/vercel is refused with `conflict` — their platform session cap makes an always-on box impossible.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Clone staged; create job enqueued',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      jobId: { type: 'string' },
                      name: { type: 'string' },
                      workspace: {
                        type: 'string',
                        description: "Host dir the clone's workspace was exported to.",
                      },
                      provider: { type: 'string' },
                      carryAsk: {
                        type: 'boolean',
                        description:
                          'Show the `carry:` question again for a list this project has already approved. A standing approval otherwise removes the prompt entirely, so this is how a client offers a review — and, by answering Skip/Cancel on the create, a way to withdraw it.',
                      },
                      files: { type: 'integer' },
                      persistent: {
                        type: 'boolean',
                        description:
                          "The always-on flag resolved for the clone. Absent when neither the request nor the source box had an opinion, leaving it to the hub's `box.persistent`.",
                      },
                    },
                    required: ['jobId', 'name', 'workspace', 'provider', 'files'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/open': {
        post: {
          tags: ['Box services'],
          summary: 'Open the box in a host app',
          description:
            'Launch the box in a host GUI app (Codex, VS Code/Cursor, cmux, Herdr, iTerm2) by re-shelling `agentbox open --in <app>`. Only works on a localhost hub running on macOS; a remote hub / non-macOS host refuses. An app must be installed and provider-eligible (e.g. Codex is Hetzner-only) — see GET /open-targets.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    app: { type: 'string', enum: ['codex', 'herdr', 'cmux', 'vscode', 'iterm2'] },
                  },
                  required: ['app'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Launched',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/open-targets': {
        get: {
          tags: ['Box services'],
          summary: 'Which host apps this hub can open a box in',
          description:
            'Reports whether the hub can launch host GUI apps (`supported` — true only on a localhost hub on macOS) and, if so, which of Codex/Herdr/cmux/VS Code/iTerm2 are installed plus their provider eligibility. Backs the box detail page "Apps" launchers.',
          responses: {
            '200': {
              description: 'Open targets',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      supported: { type: 'boolean' },
                      targets: {
                        type: ['object', 'null'],
                        additionalProperties: {
                          type: 'object',
                          properties: {
                            available: { type: 'boolean' },
                            providers: { type: 'array', items: { type: 'string' } },
                          },
                          required: ['available'],
                        },
                      },
                    },
                    required: ['supported', 'targets'],
                  },
                },
              },
            },
            '401': errorResponse,
          },
        },
      },
      '/workspaces': {
        get: {
          tags: ['Workspaces'],
          summary: 'List registered workspaces',
          description:
            'A workspace groups one or more projects — repos, identified by their origin URL — and owns a task list and its manager sessions. It is machine-independent: `hosts` maps each machine that has a checkout to its folder there, and `root` is this hub\u2019s own, absent on a hub that has none (a control box). One is created automatically when a manager session is detected in a folder no workspace contains.',
          responses: {
            '200': {
              description: 'Workspaces',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workspaces: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Workspace' },
                      },
                    },
                    required: ['workspaces'],
                  },
                },
              },
            },
            '401': errorResponse,
          },
        },
        post: {
          tags: ['Workspaces'],
          summary: "Register a workspace from the caller's scan",
          description:
            "The CLIENT scans its own folder (depth 1: a `.git` or an `agentbox.yaml`) and posts what it found; the hub stats nothing, so a hub that holds no checkout of these repos registers the same workspace. Idempotent, matched in order by `id`, then by (`host`, `root`), then by any shared repo in a record with no folder on `host` yet — that last case merges another machine's checkout in, while a second working copy on the same machine stays its own workspace. Project folders on the HUB's own machine are registered in `GET /projects` too.",
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    host: {
                      type: 'string',
                      description: '`os.hostname()` of the machine the folders are on.',
                    },
                    root: { type: 'string', description: 'Absolute folder path on `host`.' },
                    name: {
                      type: 'string',
                      description: 'Display name (default: folder basename).',
                    },
                    projects: {
                      type: 'array',
                      description: 'The projects found under `root`.',
                      items: {
                        type: 'object',
                        properties: {
                          path: { type: 'string', description: 'Absolute path on `host`.' },
                          name: { type: 'string' },
                          repoUrl: {
                            type: 'string',
                            description:
                              "The project's `origin` remote. Without one the project is host-local: no other machine can join a box to it.",
                          },
                        },
                        required: ['path'],
                      },
                    },
                    id: {
                      type: 'string',
                      pattern: '^[0-9a-f]{16}$',
                      description:
                        'Refresh this workspace (what `agentbox workspace rescan` sends) instead of matching by folder or repo.',
                    },
                  },
                  required: ['host', 'root'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The workspace',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Workspace' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}': {
        get: {
          tags: ['Workspaces'],
          summary: 'Get one workspace',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
          ],
          responses: {
            '200': {
              description: 'The workspace',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Workspace' } },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        delete: {
          tags: ['Workspaces'],
          summary: 'Unregister a workspace',
          description:
            'Drops the workspace record, its tasks and its managers. The folder, its projects and their boxes are untouched. Refused (409) while any of its managers is running, unless `force=1`.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
            {
              name: 'force',
              in: 'query',
              schema: { type: 'string', enum: ['1', 'true'] },
              description: 'Remove it even while one of its managers reads as running.',
            },
          ],
          responses: {
            '200': {
              description: 'Done',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}/rename': {
        post: {
          tags: ['Workspaces'],
          summary: 'Rename a workspace',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: 'string', maxLength: 60 } },
                  required: ['name'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The workspace',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Workspace' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}/tasks': {
        get: {
          tags: ['Tasks'],
          summary: "List a workspace's tasks",
          description:
            'In priority order (the list order IS the priority). Assignments are healed on read: a task pointed at a create job moves to the box id once the worker records it, and a task whose box is gone returns to the backlog.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
            },
            { name: 'projectId', in: 'query', schema: { type: 'string' } },
            { name: 'boxId', in: 'query', schema: { type: 'string' } },
            { name: 'managerId', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Tasks',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tasks: { type: 'array', items: { $ref: '#/components/schemas/WorkTask' } },
                    },
                    required: ['tasks'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        post: {
          tags: ['Tasks'],
          summary: 'Add a task',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', maxLength: 300 },
                    description: { type: 'string' },
                    projectId: { type: 'string', description: 'Scope the task to one project.' },
                    dependsOn: { type: 'array', items: { type: 'string', pattern: '^T-\\d+$' } },
                    createdBy: { type: 'string', enum: ['human', 'manager', 'api'] },
                    externalRef: { $ref: '#/components/schemas/WorkTaskExternalRef' },
                    boxId: { type: 'string', description: 'Assign to this box immediately.' },
                    boxJobId: {
                      type: 'string',
                      description: 'Assign to the box this create job will produce.',
                    },
                    managerId: {
                      type: 'string',
                      pattern: '^[0-9a-f]{16}$',
                      description:
                        "The manager session this task belongs to; 400 when it belongs to another workspace (or is unknown). Omitted with a box: the box's manager, when it is this workspace's.",
                    },
                    note: {
                      type: 'string',
                      maxLength: 2000,
                      description: NOTE_DESCRIPTION,
                    },
                  },
                  required: ['title'],
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The task',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/WorkTask' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}/tasks/reorder': {
        post: {
          tags: ['Tasks'],
          summary: 'Set the whole task order',
          description:
            "`ids` must be an exact permutation of the workspace's tasks — a partial list would silently renumber the rest, and this order is the priority the manager reads.",
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ids: { type: 'array', items: { type: 'string', pattern: '^T-\\d+$' } },
                    note: {
                      type: 'string',
                      maxLength: 2000,
                      description: NOTE_DESCRIPTION,
                    },
                  },
                  required: ['ids'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Tasks',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tasks: { type: 'array', items: { $ref: '#/components/schemas/WorkTask' } },
                    },
                    required: ['tasks'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}/tasks/assign': {
        post: {
          tags: ['Tasks'],
          summary: 'Assign several tasks to one box',
          description:
            'The bulk form the manager uses when it groups tasks that touch the same files into one box. Exactly one of `boxId` / `boxJobId`; a `todo` task becomes `in_progress`.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ids: { type: 'array', items: { type: 'string', pattern: '^T-\\d+$' } },
                    boxId: { type: 'string' },
                    boxJobId: { type: 'string' },
                    note: {
                      type: 'string',
                      maxLength: 2000,
                      description: NOTE_DESCRIPTION,
                    },
                  },
                  required: ['ids'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Tasks',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tasks: { type: 'array', items: { $ref: '#/components/schemas/WorkTask' } },
                    },
                    required: ['tasks'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}/tasks/{taskId}': {
        get: {
          tags: ['Tasks'],
          summary: 'Get one task',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
            {
              name: 'taskId',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^T-\\d+$' },
            },
          ],
          responses: {
            '200': {
              description: 'The task',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/WorkTask' } },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        post: {
          tags: ['Tasks'],
          summary: 'Update a task',
          description:
            'Partial update (this API has no PATCH). `projectId: null` clears the project scope and `managerId: null` the manager; an omitted field is left alone.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
            {
              name: 'taskId',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^T-\\d+$' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', maxLength: 300 },
                    description: { type: 'string' },
                    status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
                    projectId: { type: 'string', nullable: true },
                    dependsOn: { type: 'array', items: { type: 'string', pattern: '^T-\\d+$' } },
                    externalRef: { $ref: '#/components/schemas/WorkTaskExternalRef' },
                    managerId: {
                      type: 'string',
                      nullable: true,
                      description:
                        '`null` clears the manager; 400 for a manager of another workspace (or an unknown one).',
                    },
                    note: {
                      type: 'string',
                      maxLength: 2000,
                      description: NOTE_DESCRIPTION,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The task',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/WorkTask' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
        delete: {
          tags: ['Tasks'],
          summary: 'Remove a task',
          description: "Also drops the id from every other task's dependsOn.",
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
            {
              name: 'taskId',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^T-\\d+$' },
            },
          ],
          responses: {
            '200': {
              description: 'Done',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}/tasks/{taskId}/done': {
        post: {
          tags: ['Tasks'],
          summary: 'Mark a task done',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
            {
              name: 'taskId',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^T-\\d+$' },
            },
          ],
          responses: {
            '200': {
              description: 'The task',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/WorkTask' } },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}/tasks/{taskId}/assign': {
        post: {
          tags: ['Tasks'],
          summary: 'Assign one task to a box',
          description: 'Exactly one of `boxId` / `boxJobId`.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
            {
              name: 'taskId',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^T-\\d+$' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    boxId: { type: 'string' },
                    boxJobId: { type: 'string' },
                    note: { type: 'string', maxLength: 2000, description: NOTE_DESCRIPTION },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The task',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/WorkTask' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}/tasks/{taskId}/unassign': {
        post: {
          tags: ['Tasks'],
          summary: 'Return a task to the backlog',
          description: 'Finished work stays finished; only an in-progress task reverts to todo.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace id.',
            },
            {
              name: 'taskId',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^T-\\d+$' },
            },
          ],
          responses: {
            '200': {
              description: 'The task',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/WorkTask' } },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/managers': {
        get: {
          tags: ['Managers'],
          summary: 'List manager sessions across every workspace',
          description:
            'A manager is a host agent session that creates and watches boxes: `external` (a claude/codex session in your own terminal, registered when the `agentbox` CLI runs inside it) or `hub` (one this hub started in tmux). Running first, then the most recently seen. `status` is derived from the process — the tmux session for a hub manager, the pid for an external one reported from this host, else a 30-minute last-seen window. Empty on a hosted hub.',
          parameters: [
            { name: 'workspaceId', in: 'query', schema: { type: 'string' } },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['running', 'stopped'] },
            },
          ],
          responses: {
            '200': {
              description: 'Managers',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      managers: { type: 'array', items: { $ref: '#/components/schemas/Manager' } },
                    },
                    required: ['managers'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
          },
        },
      },
      '/managers/detect': {
        post: {
          tags: ['Managers'],
          summary: 'Register the host session a CLI call came from',
          description:
            "Matched by `(agent, sessionId)`, so repeating it refreshes one record (`lastSeenAt`, `pid`). A `managerId` (the caller's `$AGENTBOX_MANAGER`) joins the session to the hub-run manager it runs in. When no workspace on `host` contains `cwd`, one is created there from the caller's `projects` scan, named after the folder — except at `/`, the caller's `home`, or a folder above it, which answer 400. The folder is never stat'd: it is on the CALLER's machine. A session already registered stays in its workspace. `boxId` / `boxJobId` attaches a box this session just made in the same call. 201 when a manager or workspace was created, 200 when an existing one was refreshed.",
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agent: {
                      type: 'string',
                      description:
                        'An agent this hub knows with a session surface (not a service agent).',
                    },
                    sessionId: {
                      type: 'string',
                      description: 'Claude session uuid / codex thread uuid.',
                    },
                    cwd: { type: 'string', description: 'Absolute folder the session runs in.' },
                    pid: {
                      type: 'integer',
                      description:
                        "The agent process, probed for liveness when `host` is this hub's; its start time is recorded then too, so a reused pid does not read as running.",
                    },
                    host: {
                      type: 'string',
                      description: 'Hostname of the machine the session runs on.',
                    },
                    managerId: { type: 'string', pattern: '^[0-9a-f]{16}$' },
                    tmuxPane: {
                      type: 'string',
                      pattern: '^%\\d+$',
                      description:
                        "`$TMUX_PANE` of the session's terminal, so POST /managers/{id}/message can type into it.",
                    },
                    tmuxSession: {
                      type: 'string',
                      pattern: '^agentbox-manager-[0-9a-f]{16}$',
                      description:
                        "The AgentBox manager tmux session that pane belongs to. When it exists on the hub's machine and started in `cwd`, the manager is recorded with `kind: tmux` from it (a session from before managers were detected is adopted). A session hosted by Claude's background daemon never sends it: the daemon drops TMUX.",
                    },
                    runId: {
                      type: 'string',
                      pattern: '^[0-9a-f]{32}$',
                      description:
                        "`$AGENTBOX_MANAGER_RUN`: the run id the pty host that started this session minted. It is what makes `managerId` believable for a pty manager — Claude's daemon leaks the spawning client's environment into unrelated sessions, so the id alone proves nothing.",
                    },
                    boxId: { type: 'string' },
                    boxJobId: { type: 'string' },
                    projects: {
                      type: 'array',
                      description:
                        "The caller's scan of `cwd` (same shape as POST /workspaces), used only when a workspace has to be created here.",
                      items: {
                        type: 'object',
                        properties: {
                          path: { type: 'string' },
                          name: { type: 'string' },
                          repoUrl: { type: 'string' },
                        },
                        required: ['path'],
                      },
                    },
                    home: {
                      type: 'string',
                      description:
                        "The caller's `$HOME`: a workspace is refused at it or above it.",
                    },
                  },
                  required: ['agent', 'sessionId', 'cwd'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Refreshed',
              content: { 'application/json': { schema: detectSchema } },
            },
            '201': {
              description: 'Created',
              content: { 'application/json': { schema: detectSchema } },
            },
            '400': errorResponse,
            '401': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/managers/{id}': {
        get: {
          tags: ['Managers'],
          summary: 'Get one manager',
          parameters: [managerIdParam],
          responses: {
            '200': {
              description: 'Manager',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Manager' } } },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        delete: {
          tags: ['Managers'],
          summary: 'Forget a manager',
          description:
            'Drops the record. Its boxes and tasks are untouched (tasks keep a `managerId` nothing resolves). Refused (409) while it runs, unless `force=1` — which forgets it regardless of status and leaves its process (a tmux session, a terminal) alone.',
          parameters: [
            managerIdParam,
            {
              name: 'force',
              in: 'query',
              schema: { type: 'string', enum: ['1', 'true'] },
              description: 'Forget it regardless of status.',
            },
          ],
          responses: {
            '200': {
              description: 'Forgotten',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' } },
                    required: ['ok'],
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/managers/{id}/stop': {
        post: {
          tags: ['Managers'],
          summary: 'Stop a hub-run manager',
          description:
            "Kills its tmux session. Idempotent; the record is kept so it can be resumed. An external manager is your own terminal process, which the hub never signals: 409 while it runs, a no-op once it has exited. A claude manager whose session runs in Claude's background daemon is never ended by this: only the hub's attach session (POST /managers/{id}/attach) is closed, and the answer carries `notice` saying the session keeps running (end it with `claude stop <id>`).",
          parameters: [managerIdParam],
          responses: {
            '200': {
              description:
                "Manager, plus `notice` (string) when the agent session was left running in Claude's background daemon.",
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Manager' } } },
            },
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/managers/{id}/resume': {
        post: {
          tags: ['Managers'],
          summary: "Resume a manager's session in the hub",
          description:
            "Reopens the session in a tmux session the hub owns (`claude --resume <id>` / `codex resume <id>`, run in the manager's `cwd`), and the manager becomes `hub`-run. 409 while the session still runs anywhere (two processes writing one transcript corrupt it), for a manager with no session id, for an agent whose sessions cannot be resumed, and for an external session reported from another host (its transcript is not on this machine); 503 when the hub host has no tmux.",
          parameters: [managerIdParam],
          responses: {
            '200': {
              description: 'Manager',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Manager' } } },
            },
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/managers/{id}/attach': {
        post: {
          tags: ['Managers'],
          summary: "Open a manager's Claude background session in the hub",
          description:
            "For a claude manager whose session is a detached Claude Code background session (`background` on the manager): starts, or reuses, the tmux session `agentbox-manager-<managerId>` on the hub user's default tmux server running `claude attach <background.id>` in the manager's `cwd`, and answers the manager with `attachCommand` for it. The record keeps its kind, session id and pid. The session keeps running in Claude's daemon when that tmux session ends, and the manager stays `running`. 409 when the manager has no running background session, or when something the hub can see may already show it (an AgentBox tmux session starting in its folder, or a `claude attach` client); 503 when the hub host has no tmux.",
          parameters: [managerIdParam],
          responses: {
            '200': {
              description: 'Manager',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Manager' } } },
            },
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/managers/{id}/notes': {
        post: {
          tags: ['Managers', 'Timeline'],
          summary: 'Record a manager note on the timeline',
          description:
            "A note explaining what the manager decided (`kind`: `note`, `replan` when it re-planned, `plan` when it made one). Stamped with the manager's current turn and that turn's prompt when its transcript is on this hub's disk.",
          parameters: [managerIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', maxLength: 2000 },
                    kind: { type: 'string', enum: ['note', 'replan', 'plan'] },
                  },
                  required: ['text'],
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The recorded event',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/TimelineEvent' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/managers/{id}/heartbeat': {
        post: {
          tags: ['Managers'],
          summary: 'Report what the machine a manager runs on sees',
          description:
            "A hub that only HOLDS the record cannot probe a pid, a tmux server or a transcript on another machine, so the machine that runs the manager reports instead — every 30 s, and right after a start, resume, stop or attach. The reported values drive that manager's row (status, title, turn, background session) until three intervals pass with no heartbeat, after which the record falls back to its last-seen window. 409 `wrong_host` for a record whose `host` is this hub's own: there the process is readable, and a report nothing can check must not override it.",
          parameters: [managerIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['running', 'stopped'] },
                    sessionId: { type: 'string' },
                    title: { type: 'string' },
                    turn: {
                      type: 'number',
                      description: "1-based count of the session's user turns.",
                    },
                    prompt: { type: 'string', description: "That turn's prompt, as one line." },
                    lastExit: { type: 'number' },
                    background: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        status: { type: 'string' },
                        state: { type: 'string' },
                        name: { type: 'string' },
                      },
                      required: ['id'],
                    },
                    terminalSession: { type: 'string', pattern: '^agentbox-manager-[0-9a-f]{16}$' },
                    tmuxSession: {
                      type: 'string',
                      pattern: '^agentbox-manager-[0-9a-f]{16}$',
                      description: 'The tmux session showing it right now, when one does.',
                    },
                    ptyAttach: {
                      type: 'object',
                      description:
                        'How to attach, when the reporting machine runs it on a pty host.',
                      properties: {
                        command: { type: 'array', items: { type: 'string' } },
                        socket: { type: 'string' },
                        protocol: { type: 'number' },
                      },
                    },
                  },
                  required: ['status'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Manager',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Manager' } } },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
          },
        },
      },
      '/managers/{id}/attach-box': {
        post: {
          tags: ['Managers'],
          summary: 'Record a box a manager produced',
          description:
            "The hub that BUILT a box says which manager it belongs to. Usually that is this hub and nothing travels; with a control box configured and `hub.mode=local` the box is built on the user's own machine while the record lives here, and the id is a fact only the builder has. Send `boxJobId` while the create is still a queued job (it is promoted to the box id when the worker writes it back) or `boxId` for a box that exists. Appends one id to the manager's list and can neither move nor remove anything, which is why — unlike every other patch — it is accepted from another host.",
          parameters: [managerIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    boxId: { type: 'string' },
                    boxJobId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Attached',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/managers/{id}/message': {
        post: {
          tags: ['Managers', 'Timeline'],
          summary: "Type a message into a manager's session",
          description:
            "Types `text` into the session and submits it (newlines are flattened to spaces). A running hub-run manager gets it in its tmux session (`delivered: session`); a running external manager in the tmux pane it reported at detect (`pane`, only when it runs on this hub's machine); a stopped manager with a session is resumed in the hub's tmux with the text as its prompt (`resumed`). A running external manager outside tmux answers 409 with code `manager_unreachable` — a client offers the text to paste instead. `prNumber` (with `repo`, `owner/name`, when the workspace spans several repos) ties the message to a PR, which is how a later merge shows `approvedByYou`; without `repo` the PR is matched only when one repo in the log has that number. Records `manager.message` on success.",
          parameters: [managerIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', maxLength: 2000 },
                    prNumber: { type: 'integer', minimum: 1 },
                    repo: {
                      type: 'string',
                      pattern: '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$',
                      description: '`owner/name` of the PR; requires `prNumber`.',
                    },
                  },
                  required: ['text'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Delivered',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      delivered: { type: 'string', enum: ['session', 'pane', 'resumed'] },
                      manager: { $ref: '#/components/schemas/Manager' },
                      event: {
                        oneOf: [{ $ref: '#/components/schemas/TimelineEvent' }, { type: 'null' }],
                      },
                    },
                    required: ['delivered', 'manager', 'event'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}/timeline': {
        get: {
          tags: ['Timeline'],
          summary: "A workspace's timeline",
          description:
            "What happened in the workspace, newest first: task, manager, box, push and PR events from its append-only log, with 3+ task creates from one manager turn (within 10 minutes) collapsed into one `plan` item. `live` holds the rows true right now, never stored: a box working an in-progress task (with its uncommitted diff when running) and a ready PR nobody merged yet (`awaiting`, `approved` once a message about it was sent). `?since=` adds a `summary` of what changed since then. A GitHub sync (`gh pr list` on the repos behind the workspace's projects) starts in the background when the last one is over a minute old; `github` reports it, and rows it adds fire the usual change event.",
          parameters: [
            workspaceIdParam,
            {
              name: 'before',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only items strictly older than this ISO time (paging).',
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            },
            {
              name: 'since',
              in: 'query',
              schema: { type: 'string' },
              description: 'ISO time the summary counts from; items are not filtered by it.',
            },
            {
              name: 'sync',
              in: 'query',
              schema: { type: 'string', enum: ['0'] },
              description:
                '`0`: do not start a GitHub sync; `github` reports the last one (`syncing` before any). For a small read on every refresh. Any other value, or none, keeps the default.',
            },
            {
              name: 'managerId',
              in: 'query',
              schema: { type: 'string' },
              description:
                "Only one manager session's rows — the ones it stamped, and the ones on a box it owns (most box, push and PR rows carry no `managerId` of their own). Narrows `items`, `live` and the `summary` alike. An id no manager in this workspace has yields an empty timeline, not an error. Lanes are still assigned over the whole log before the filter, so a kept row may fork from or merge into a lane with no rows left on the page.",
            },
          ],
          responses: {
            '200': {
              description: 'Timeline',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Timeline' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/workspaces/{id}/timeline/events': {
        post: {
          tags: ['Timeline'],
          summary: 'Record one event from another hub',
          description:
            "Append one event to this workspace's log. For a hub that does NOT hold the store: with a control box configured, the workspaces, tasks and timeline live there, so a PC hub's own rows (its docker boxes' lifecycle, its queue worker's `box.ready`, an in-box `git push` its relay saw) are forwarded here. `actor` is limited to `box`, `hub` and `manager` — a human action is made through this hub's own routes, which stamp it from the session header. `key` dedupes: a retried report lands once, and the second call answers 200 instead of 201. `id` is minted here; `at` is honoured, so a late forward keeps the time the thing happened.",
          parameters: [workspaceIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/TimelineEventInput' } },
            },
          },
          responses: {
            '201': {
              description: 'Recorded',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { event: { $ref: '#/components/schemas/TimelineEvent' } },
                    required: ['event'],
                  },
                },
              },
            },
            '200': {
              description: 'Already recorded (the event key was in the log)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { deduped: { type: 'boolean' } },
                    required: ['deduped'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/workspaces/{id}/managers': {
        get: {
          tags: ['Managers'],
          summary: "List a workspace's managers",
          parameters: [workspaceIdParam],
          responses: {
            '200': {
              description: 'Managers',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      managers: { type: 'array', items: { $ref: '#/components/schemas/Manager' } },
                    },
                    required: ['managers'],
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/workspaces/{id}/managers/start': {
        post: {
          tags: ['Managers'],
          summary: 'Start a manager agent in the workspace folder',
          description:
            'Runs a coding agent LOCALLY in the workspace folder, in a detached tmux session the hub owns, with AGENTBOX_WORKSPACE and AGENTBOX_MANAGER set. Clients attach to that session rather than the hub proxying a terminal. Send `agent` — one this hub knows, has installed, and can attach to (a `service` agent is a daemon and is refused) — optionally with a `sessionId` to resume (claude and codex only). A `sessionId` some manager already holds resumes that manager rather than creating a second one (409 while it runs, unless `restart` and it is hub-run). There is deliberately no free-form command, and `sessionId` must look like an id: this runs on the hub host, not in a box. 503 when the hub host has no tmux.',
          parameters: [workspaceIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agent: {
                      type: 'string',
                      description:
                        'An agent this hub knows (GET /agents); the built-ins are claude, codex, opencode and pi.',
                    },
                    sessionId: {
                      type: 'string',
                      description:
                        'Resume this session (claude and codex only; refused for any other agent).',
                    },
                    restart: {
                      type: 'boolean',
                      description:
                        'With a `sessionId` whose hub-run manager is running: restart it instead of refusing.',
                    },
                  },
                  required: ['agent'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Manager',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Manager' } } },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/workspaces/{id}/managers/register': {
        post: {
          tags: ['Managers'],
          summary: 'Record a manager session another machine opened',
          description:
            "A manager runs where its folder is: a hub with a control box configured starts the tmux session on ITS machine and registers the record here, where the workspace, its tasks and its timeline live. Sending an `id` moves that manager onto the new session (a resume, logged as `manager.resumed`); without one a manager is minted (`manager.started`). This and POST /managers/{id}/heartbeat are the only manager writes accepted from another host — start, resume, attach, stop and message all need the session's own machine and answer 409 `wrong_host` elsewhere. `argv` is recorded, never executed here.",
          parameters: [workspaceIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: {
                      type: 'string',
                      pattern: '^[0-9a-f]{16}$',
                      description: 'An existing manager to move onto this session.',
                    },
                    agent: {
                      type: 'string',
                      description: 'An agent this hub knows (GET /agents).',
                    },
                    kind: {
                      type: 'string',
                      enum: ['tmux', 'pty'],
                      description:
                        'Which carrier ran it. `pty` requires `pty`, `tmux` requires `tmuxSession`.',
                    },
                    host: {
                      type: 'string',
                      description: 'os.hostname() of the machine the session runs on.',
                    },
                    cwd: { type: 'string', description: 'Absolute folder on that machine.' },
                    tmuxSession: {
                      type: 'string',
                      pattern: '^agentbox-manager-[0-9a-f]{16}$',
                    },
                    pty: {
                      type: 'object',
                      description: 'The pty host serving this session, on `host`.',
                      properties: {
                        pid: { type: 'number' },
                        socket: { type: 'string' },
                        runId: {
                          type: 'string',
                          pattern: '^[0-9a-f]{32}$',
                          description:
                            "Minted by the host and exported into the agent's environment, so a later detect can prove which manager it is.",
                        },
                        pidStartedAt: { type: 'string' },
                      },
                      required: ['pid', 'socket', 'runId'],
                    },
                    sessionId: { type: 'string' },
                    argv: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'What was run, for the record. Never executed by this hub.',
                    },
                  },
                  required: ['agent', 'kind', 'host', 'cwd'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Manager',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Manager' } } },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
          },
        },
      },
      '/workspaces/{id}/managers/sessions': {
        get: {
          tags: ['Managers'],
          summary: 'Resumable agent sessions for the workspace folder',
          description:
            'Read from the agent\'s own on-disk store, for the "resume a session" picker, newest first. Only claude and codex are readable today; for anything else `supported: false` means that agent\'s session format is not one we can resume — not an error.',
          parameters: [
            workspaceIdParam,
            { name: 'agent', in: 'query', schema: { type: 'string', default: 'claude' } },
          ],
          responses: {
            '200': {
              description: 'Sessions',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      agent: { type: 'string' },
                      supported: { type: 'boolean' },
                      sessions: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/HostSession' },
                      },
                    },
                    required: ['agent', 'supported', 'sessions'],
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            // The sessions are files in the folder's own store: a workspace with
            // no checkout here is `wrong_host`, naming the machines that have one.
            '409': errorResponse,
          },
        },
      },
      '/tasks': {
        get: {
          tags: ['Tasks'],
          summary: 'List tasks across every workspace',
          description:
            'The cross-workspace read a fleet view needs: answers "what is assigned to this box" without knowing which workspace owns it.',
          parameters: [
            { name: 'workspaceId', in: 'query', schema: { type: 'string' } },
            { name: 'projectId', in: 'query', schema: { type: 'string' } },
            { name: 'boxId', in: 'query', schema: { type: 'string' } },
            { name: 'managerId', in: 'query', schema: { type: 'string' } },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
            },
          ],
          responses: {
            '200': {
              description: 'Tasks',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      tasks: { type: 'array', items: { $ref: '#/components/schemas/WorkTask' } },
                    },
                    required: ['tasks'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
          },
        },
      },
      '/projects': {
        get: {
          tags: ['Projects'],
          summary: 'List registered projects',
          responses: {
            '200': {
              description: 'Projects',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      projects: { type: 'array', items: { $ref: '#/components/schemas/Project' } },
                    },
                    required: ['projects'],
                  },
                },
              },
            },
            '401': errorResponse,
          },
        },
        post: {
          tags: ['Projects'],
          summary: 'Register a folder as a project, or create a new one',
          description:
            'Exactly one body shape. `{ path }` registers a folder that already exists. ' +
            '`{ parent, name, git? }` creates `<parent>/<name>` (empty, or with `git: true` a repo on `main` ' +
            'with a `.gitignore` and an initial commit) and registers it; refused when the target exists ' +
            'or the parent sits inside another project.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      title: 'RegisterProject',
                      properties: {
                        path: { type: 'string', description: 'Absolute path to the folder.' },
                      },
                      required: ['path'],
                    },
                    {
                      type: 'object',
                      title: 'CreateProject',
                      properties: {
                        parent: {
                          type: 'string',
                          description: 'Absolute path of the existing folder to create into.',
                        },
                        name: {
                          type: 'string',
                          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$',
                          description: 'New folder name (one path segment, no leading dot).',
                        },
                        git: {
                          type: 'boolean',
                          default: false,
                          description: 'Initialize a git repository with an initial commit.',
                        },
                      },
                      required: ['parent', 'name'],
                    },
                  ],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Registered (or created and registered)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { const: true },
                      id: {
                        type: 'string',
                        description: 'Project id (hash of the canonical root).',
                      },
                      path: { type: 'string', description: 'Canonical project root.' },
                    },
                    required: ['ok', 'id', 'path'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/projects/{id}': {
        delete: {
          tags: ['Projects'],
          summary: 'Unregister an empty project',
          description: 'Folder/files on disk are untouched.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Removed',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse, // project still has boxes
            '503': errorResponse,
          },
        },
      },
      '/projects/{id}/bots': {
        get: {
          tags: ['Projects'],
          summary: 'Bots this project holds a backup of',
          description:
            'Every bot under `<project>/.agentbox/bots/`, alphabetically, each with its backups newest first and its manifest folded in. The source for a restore picker. `latest` is the stamp the bot\'s `latest` link resolves to, omitted when the link is missing or dangling. `state: false` on a backup means it captured only a workspace — restoring one gives a working box with a FRESH identity, which is not what "restore this bot" promises, so a picker must surface it. Read-only, but host-backed: the bundles are on the hub\'s own disk.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Bots and their backups',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      bots: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            bot: { type: 'string' },
                            latest: { type: 'string' },
                            backups: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  stamp: { type: 'string' },
                                  agent: { type: 'string' },
                                  state: { type: 'boolean' },
                                  boxName: { type: 'string' },
                                  provider: { type: 'string' },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/projects/{id}/restore': {
        post: {
          tags: ['Projects'],
          summary: 'Bring a backed-up bot back as a new box, identity included',
          description:
            "The inverse of `POST /boxes/{id}/backup`, and the opposite of `clone`: a clone deliberately starts a SECOND bot with a fresh identity, a restore puts the ORIGINAL one back — same gateway token, same channel pairings, same history, on whichever provider you point it at. Project-scoped because a bundle outlives the box it came from, which is what a backup is for; the project is what still exists. Two steps behind one call, exactly like `clone`: the bundle's workspace half is staged into `<project>/.agentbox/bots/{bot}/workspace` (or `into`) and registered as a project, then a normal create is enqueued in the ungated foreground lane; the STATE half is applied by the queue worker once the box's service has come up on its own. REFUSALS, both before anything is written: the source box still running (two live gateways cannot share one identity — the failure a per-box state dir exists to prevent), and a destination another box already runs on. `force` overrides both. A bundle with `state: false` is refused by name rather than half-delivered. Returns the create job — stream it through `GET /jobs/{jobId}/logs`. Backs `agentbox <service-agent> --restore <bot>`.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['bot'],
                  properties: {
                    bot: { type: 'string', description: 'Which bot to bring back.' },
                    stamp: {
                      type: 'string',
                      description: "Which backup. Default: whatever the bot's `latest` points at.",
                    },
                    name: {
                      type: 'string',
                      description: 'Name for the new box (default: the bot name).',
                    },
                    provider: {
                      type: 'string',
                      description:
                        'Provider for the new box (default: the one the bundle was captured on). A bundle is provider-neutral files, so this may differ.',
                    },
                    into: {
                      type: 'string',
                      description:
                        "Where the restored workspace lives, on the HUB's machine. MUST be absolute — a working directory is client state that does not travel over an API.",
                    },
                    force: {
                      type: 'boolean',
                      description:
                        'Proceed even when the source box is still running, or the destination is not empty.',
                    },
                    persistent: {
                      type: 'boolean',
                      description:
                        'Always-on flag for the restored box. Defaults to true — a bot is an always-on box, and a restored one is the same bot.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Workspace staged; create job enqueued',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      jobId: { type: 'string' },
                      name: { type: 'string' },
                      workspace: { type: 'string' },
                      provider: { type: 'string' },
                      bot: { type: 'string' },
                      stamp: { type: 'string' },
                      agent: { type: 'string' },
                      files: { type: 'number' },
                      persistent: { type: 'boolean' },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/projects/{id}/branches': {
        get: {
          tags: ['Projects'],
          summary: "List a project's branches",
          description:
            'Local + remote branches and the current HEAD, for the create-box base-branch picker.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Branches',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/BranchList' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/projects/{id}/create-preflight': {
        post: {
          tags: ['Projects'],
          summary: 'What would creating a box here ask the user?',
          description:
            'The host-boundary questions a create for this project would ask — a project\'s `carry:` block, the host login a service agent would borrow — as `PromptRequest` objects a client renders and answers. Answers ride back on `POST /api/v1/boxes` as `opts.promptAnswers`.\n\nThe list comes from running the real gates with a collecting asker, so it can never differ from what the create asks. `unavailable` names each gate this hub cannot run and why: a control box has no local checkout of the project, so it can read neither the files a `carry:` block names nor the host logins a box would borrow, and says so rather than returning an empty list that looks like "nothing to ask".\n\nA client that skips this endpoint still creates boxes: every prompt carries a `fallback`. But a prompt marked `required` — `carry:`, whose silent answer would move host secrets — has no safe fallback, and a create that leaves it unanswered is refused.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['agent'],
                  properties: {
                    agent: {
                      type: 'string',
                      description:
                        'Agent the box would run; decides which agent-specific gates apply. `none` for an agentless box.',
                    },
                    provider: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The questions this create would ask',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/CreatePreflight' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/projects/{id}/seed': {
        get: {
          tags: ['Projects'],
          summary: "Get a project's seed / custody status",
          description:
            'What `agentbox hub project push` stored on the control box (untracked + env/secret tarballs + manifest), as paths, hashes and timestamps only — never seed contents. `custodyAvailable` is false on a hub that is not a control box.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Seed status',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ProjectSeed' } },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/agents': {
        get: {
          tags: ['Agents'],
          summary: 'List coding agents',
          description:
            'The agents a picker should offer, from the agent registry (so an agent registered ' +
            'with `agentbox agent add` is included). `installed` reports whether THIS machine ' +
            "holds the agent's config directory or an AgentBox-saved login for it; it is a " +
            'hint for what to offer first, not a gate — an agent installs on demand inside a ' +
            'box. Omitted when the hub cannot answer for a host (the hosted plane), which ' +
            'clients read as unknown rather than as false.',
          responses: {
            '200': {
              description: 'Agents',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      agents: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Agent' },
                      },
                    },
                    required: ['agents'],
                  },
                },
              },
            },
            '401': errorResponse,
          },
        },
      },
      '/providers': {
        get: {
          tags: ['Providers'],
          summary: 'List sandbox providers',
          description: 'With credential + baked status on this host.',
          responses: {
            '200': {
              description: 'Providers',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      providers: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Provider' },
                      },
                    },
                    required: ['providers'],
                  },
                },
              },
            },
            '401': errorResponse,
          },
        },
      },
      '/providers/{id}/credentials': {
        post: {
          tags: ['Providers'],
          summary: "Set a provider's credentials",
          description:
            'API keys/tokens, validated then saved to secrets.env. Never echoes secret values.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description:
                'Provider name. Built-ins are docker, daytona, hetzner, vercel, e2b, digitalocean, remote-docker; a provider registered with `agentbox plugin add` uses its own name.',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                  description:
                    'Provider-specific fields, e.g. { apiKey } (e2b), { token } (hetzner), { apiKey } or { jwtToken, organizationId } (daytona), { token, teamId?, projectId? } (vercel).',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Saved',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/providers/{id}/size-check': {
        post: {
          tags: ['Providers'],
          summary: 'Would a box created at this size actually get it?',
          description:
            'Most backends apply a size per create and answer false. Daytona and e2b fix CPU/memory when the base is baked and discard anything else, so they answer true with the reason to show. Lets a create form re-bake only when the size really differs from the baked one. Advisory: an unresolvable provider or a backend with no opinion answers false.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description:
                'Provider name. Built-ins are docker, daytona, hetzner, vercel, e2b, digitalocean, remote-docker; a provider registered with `agentbox plugin add` uses its own name.',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    size: {
                      type: 'string',
                      description:
                        'A literal --size value for this provider (e.g. cx43, 4, 4-8-10). Opaque here — the provider parses it.',
                    },
                  },
                  required: ['size'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Verdict',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      rebakeRequired: {
                        type: 'boolean',
                        description:
                          'true = a plain create would discard this size; bake first with POST /providers/{id}/prepare { size, force: true }. `force` matters: a size change does not move the build-context fingerprint, so without it the bake is a no-op.',
                      },
                      reason: {
                        type: 'string',
                        description: "Why, in the provider's own words. Only when rebakeRequired.",
                      },
                    },
                    required: ['rebakeRequired'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/providers/{id}/prepare': {
        post: {
          tags: ['Providers'],
          summary: "Bake a provider's base image",
          description: 'Async — returns a job id. Progress streams over GET /jobs/{id}/logs.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description:
                'Provider name. Built-ins are docker, daytona, hetzner, vercel, e2b, digitalocean, remote-docker; a provider registered with `agentbox plugin add` uses its own name.',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    force: { type: 'boolean' },
                    agentSettings: {
                      type: 'object',
                      additionalProperties: {
                        type: 'object',
                        additionalProperties: { type: ['string', 'boolean'] },
                      },
                      description:
                        'Per-agent settings for the bake, keyed by agent id (e.g. {"claude":{"install":"npm"}}). Which keys an agent declares is runtime data - see `agentbox config list`.',
                    },
                    agents: {
                      type: 'array',
                      items: { type: 'string', enum: ['claude', 'codex', 'opencode', 'pi'] },
                      description:
                        'Agents to bake into the base. Omitted/empty bakes an agentless base.',
                    },
                    build: { type: 'boolean' },
                    size: { type: 'string' },
                    location: { type: 'string' },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '202': {
              description: 'Bake enqueued',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { jobId: { type: 'string' } },
                    required: ['jobId'],
                  },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/hosts': {
        get: {
          tags: ['Hosts'],
          summary: 'List remote-docker host aliases',
          description: 'Each with its SSH connection and baked/default state.',
          responses: {
            '200': {
              description: 'Hosts',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      hosts: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            alias: { type: 'string' },
                            ssh: { type: 'string' },
                            baked: { type: 'boolean' },
                            bakedImageRef: { type: 'string' },
                            default: { type: 'boolean' },
                          },
                          required: ['alias', 'ssh', 'baked', 'default'],
                        },
                      },
                    },
                    required: ['hosts'],
                  },
                },
              },
            },
            '401': errorResponse,
            '503': errorResponse,
          },
        },
        post: {
          tags: ['Hosts'],
          summary: 'Register a remote-docker host alias',
          description:
            'Probes the host (ssh + docker) before saving. Does not bake the image (builds on first create). `default` also pins box.remoteDockerHost.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    alias: { type: 'string' },
                    ssh: {
                      type: 'string',
                      description: 'an ~/.ssh/config alias or [user@]host[:port]',
                    },
                    default: { type: 'boolean' },
                  },
                  required: ['alias', 'ssh'],
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Registered',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/hosts/{alias}': {
        delete: {
          tags: ['Hosts'],
          summary: 'Forget a remote-docker host alias',
          description:
            'Drops the alias + baked-image record + default. Local record only. Returns boxes created against it (now unreachable).',
          parameters: [{ name: 'alias', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Removed',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { const: true },
                      boxesAffected: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['ok', 'boxesAffected'],
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/hosts/{alias}/bake': {
        post: {
          tags: ['Hosts'],
          summary: 'Bake the box image on a host',
          description:
            'Async — returns a job id. Progress streams over GET /jobs/{id}/logs (pull from GHCR is fast; a registry-miss build is slow).',
          parameters: [{ name: 'alias', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '202': {
              description: 'Bake enqueued',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { jobId: { type: 'string' } },
                    required: ['jobId'],
                  },
                },
              },
            },
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/checkpoints': {
        get: {
          tags: ['Checkpoints'],
          summary: "List a project's (or every project's) checkpoints",
          description:
            'The project checkpoint store lives on the hub machine, keyed by the absolute project root. Pass `?project=<abs root>` for one project, or `?global=1` for every project. Backs `agentbox checkpoint ls` / `ls -g`.',
          parameters: [
            {
              name: 'project',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Absolute project root (required unless global=1).',
            },
            {
              name: 'global',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['1'] },
              description: 'List checkpoints for every project.',
            },
          ],
          responses: {
            '200': {
              description: 'Checkpoints',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/CheckpointListing' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '503': errorResponse,
          },
        },
        delete: {
          tags: ['Checkpoints'],
          summary: 'Delete a checkpoint',
          description:
            'Removes one checkpoint from every store that had it and sweeps any dangling default-checkpoint config pointer. Backs `agentbox checkpoint rm`.',
          parameters: [
            {
              name: 'project',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: 'Absolute project root.',
            },
            {
              name: 'ref',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: 'The checkpoint name.',
            },
            {
              name: 'provider',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Scope the delete to one provider store.',
            },
          ],
          responses: {
            '200': {
              description: 'Deleted',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CheckpointRemoveResult' },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/prune': {
        post: {
          tags: ['Fleet'],
          summary: 'Prune orphan boxes and resources',
          description:
            'Without a provider (or provider `docker`) it reaps orphan docker records, containers, volumes, snapshot/box dirs — and, with `all`, orphan project configs. With a cloud provider it enumerates untracked sandboxes and (when not a `dryRun`) deletes them AND reaps their control-box registrations. Durable project checkpoints are always left intact. Backs `agentbox prune`.',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    provider: {
                      type: 'string',
                      description:
                        'Cloud provider to prune; omit (or `docker`) for the local docker sweep.',
                    },
                    all: {
                      type: 'boolean',
                      description: 'docker: also remove orphan per-project config dirs.',
                    },
                    dryRun: {
                      type: 'boolean',
                      description: 'Report what would be removed without removing anything.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Prune result',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/PruneResult' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '409': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/approvals': {
        get: {
          tags: ['Approvals'],
          summary: 'List pending host-action approvals',
          responses: {
            '200': {
              description: 'Approvals',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      approvals: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Approval' },
                      },
                    },
                    required: ['approvals'],
                  },
                },
              },
            },
            '401': errorResponse,
          },
        },
      },
      '/approvals/{id}/answer': {
        post: {
          tags: ['Approvals'],
          summary: 'Answer a pending approval',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    answer: { type: 'string', enum: ['y', 'n'] },
                    cancelled: {
                      type: 'boolean',
                      description:
                        'Mark a dismissal distinctly from a plain deny in the audit trail (the `agent approve --cancel` capability). Still leaves the action unapproved.',
                    },
                    openedByClient: {
                      type: 'boolean',
                      description:
                        '`open-link` only: this client already opened the URL on its own machine, so the host must not open it again. Answering is also the CLAIM — several surfaces see the same link and only the first gets 200; a 404 means someone else opened it, so open nothing.',
                    },
                  },
                  required: ['answer'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Resolved',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/boxes/{id}/stream': {
        get: {
          tags: ['Approvals'],
          summary: "Subscribe to a box's live event stream (SSE)",
          description:
            "Payload-carrying Server-Sent Events for one box — the attach footer's channel. Emits `open` (first frame of every connect, followed by a backlog flush of everything still live), `prompt-ask` (the full pending-approval payload), `prompt-resolved` (`{ id }`), `notice-set`/`notice-clear`, `box-status` (the in-box daemon's latest snapshot: agent activity, session titles, service/task states), and a `ping` heartbeat. `box-status` is the only status source for a box this hub owns but the client does not — the durable status file is written by whichever relay the box reports to. Distinct from GET /api/events, which carries refetch signals only (`data: {}`). Degrades to open + heartbeat on a hub topology with no in-process relay.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'SSE stream (text/event-stream)',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
            '401': errorResponse,
          },
        },
      },
      '/jobs': {
        get: {
          tags: ['Jobs'],
          summary: 'List background jobs',
          description:
            "The unified job listing — the local file queue's create jobs merged with, on a control box, the control-plane create queue. Backs `agentbox queue list` and `agentbox hub jobs`.",
          responses: {
            '200': {
              description: 'Jobs',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      jobs: { type: 'array', items: { $ref: '#/components/schemas/JobListItem' } },
                    },
                    required: ['jobs'],
                  },
                },
              },
            },
            '401': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/jobs/{id}': {
        get: {
          tags: ['Jobs'],
          summary: 'Get a create job status',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Job',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } },
            },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/jobs/{id}/logs': {
        get: {
          tags: ['Jobs'],
          summary: 'Stream a create job log (SSE)',
          description:
            'text/event-stream. Emits `open`, then `log` events per line, then a terminal `end` event with the final status.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'SSE stream', content: { 'text/event-stream': {} } },
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/jobs/{id}/login-code': {
        post: {
          tags: ['Jobs'],
          summary: 'Deliver an OAuth login code to a create job',
          description:
            'Feeds a pasted Claude OAuth approval code to a create job that is awaiting a re-login. The create worker consumes it and completes the in-box login. The one interactive create affordance that survives.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { code: { type: 'string', description: 'The OAuth approval code.' } },
                  required: ['code'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Accepted',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
                },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/custody': {
        get: {
          tags: ['Custody'],
          summary: 'List the custody manifest (metadata only)',
          description:
            'What the hub holds so a box created from either side is usable from both: agent credentials, project seeds, provider bake records, and per-box SSH keys. Returns paths, hashes, sizes and mtimes ONLY — value bytes never leave the box (same contract as `agentbox hub custody list`). Optional `?prefix=` scopes the listing to a custody scope (`agents` | `projects` | `prepared` | `boxes`) or a `scope/subject`.',
          parameters: [
            {
              name: 'prefix',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'A custody scope or scope/subject, e.g. `agents` or `boxes/box-abc`.',
            },
          ],
          responses: {
            '200': {
              description: 'Custody manifest',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Custody' } } },
            },
            '400': errorResponse,
            '401': errorResponse,
          },
        },
      },
      '/custody/{path}': {
        parameters: [
          {
            name: 'path',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description:
              'Custody path, e.g. `agents/claude/.credentials.json` or `boxes/box-abc/ssh/id_ed25519`.',
          },
        ],
        get: {
          tags: ['Custody'],
          summary: 'Read a stored blob (ELEVATED — admin token required on a control box)',
          description:
            'Returns the entry metadata AND its bytes (`data`, base64). This is the ONE byte-returning custody route, so it is gated beyond the hub API key: on a control box (password profile) it additionally requires the admin token in `X-Agentbox-Admin-Token` — a byte-read with only the API key is `401`, so a value never leaves the box to a thin client. A localhost hub (token profile) needs no admin token: its hub token is a machine-local secret that already gates the whole surface. Backs `agentbox hub credentials pull` / `custody pull` and per-box SSH-key adoption.',
          responses: {
            '200': {
              description: 'The stored entry + its base64 bytes',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/CustodyValue' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        put: {
          tags: ['Custody'],
          summary: 'Store bytes at a custody path (metadata-only response)',
          description:
            'Stores `data` (base64) at the path. Content-addressed: `changed` is false when the identical bytes were already there. The response is METADATA ONLY — it never echoes the stored value. Backs `agentbox hub credentials/secrets/project push`.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data'],
                  properties: { data: { type: 'string', description: 'base64-encoded bytes' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Stored (metadata only)',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/CustodyPutResult' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
          },
        },
        delete: {
          tags: ['Custody'],
          summary: 'Delete a custody entry',
          description: 'Removes one entry. Backs `agentbox hub custody rm`.',
          responses: {
            '204': { description: 'Deleted' },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/custody/blob/{path}': {
        parameters: [
          {
            name: 'path',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Custody path, e.g. `projects/acme__web/seed/carry.tar.gz`.',
          },
        ],
        get: {
          tags: ['Custody'],
          summary: 'Stream a stored blob (ELEVATED — admin token required on a control box)',
          description:
            'Raw `application/octet-stream` counterpart of GET /custody/{path}, for values too large to buffer as base64. Same elevated gate, for the same reason (custody holds credentials and SSH private keys) — streaming changes the transport, never the trust. `X-Agentbox-Sha256` carries the digest.',
          responses: {
            '200': {
              description: 'The stored bytes',
              content: {
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
          },
        },
        put: {
          tags: ['Custody'],
          summary: 'Stream bytes into a custody path',
          description:
            "Raw `application/octet-stream` counterpart of PUT /custody/{path}. The JSON route stays the simple, general-purpose API for small values (credentials, .env, SSH keys); this one exists for payloads where base64-in-JSON costs several times the payload in peak memory on both ends — chiefly a project's `carry:` material, which can run to `box.cpMaxBytes` (100 MiB). Capped by AGENTBOX_CUSTODY_MAX_BLOB_BYTES and enforced mid-stream, so an over-cap upload is cut off rather than landed. Returns metadata only, and is content-addressed (`changed: false` when the bytes were already stored).",
          requestBody: {
            required: true,
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: {
            '200': {
              description: 'Stored (metadata only)',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/CustodyPutResult' } },
              },
            },
            '400': errorResponse,
            '401': errorResponse,
          },
        },
      },
      '/system': {
        get: {
          tags: ['System'],
          summary: 'Get hub build + provider bake status',
          description:
            'Answers "what is running here, and do I need to re-bake?": hub version + channel + build source, the deploy record (when this machine is an exposed/deployed control box), each base provider’s baked fingerprint and freshness (`baseStatus` `stale` = re-bake), and the box-image build-context manifest. Freshness is populated only on the in-process host topology (like GET /providers?freshness=1).',
          responses: {
            '200': {
              description: 'System info',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/System' } } },
            },
            '401': errorResponse,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'The hub token (Authorization: Bearer <token>).',
        },
      },
      schemas: {
        Health: {
          type: 'object',
          properties: {
            ok: { const: true },
            apiVersion: { type: 'string' },
            profile: { type: 'string' },
          },
          required: ['ok', 'apiVersion'],
        },
        CustodyEntry: {
          type: 'object',
          description: 'One stored item — metadata only; the value bytes are never returned.',
          properties: {
            path: {
              type: 'string',
              description: 'Custody-relative path, e.g. agents/claude/.credentials.json',
            },
            size: { type: 'number' },
            sha256: { type: 'string', description: 'Hex sha256 of the stored bytes' },
            mode: { type: 'number', description: 'POSIX mode of the stored value' },
            updatedAt: { type: 'string', description: 'ISO timestamp of the last write' },
          },
          required: ['path', 'size', 'sha256', 'mode', 'updatedAt'],
        },
        CustodyPutResult: {
          type: 'object',
          description: 'A store result — metadata only, never the stored value.',
          allOf: [
            { $ref: '#/components/schemas/CustodyEntry' },
            {
              type: 'object',
              properties: {
                changed: {
                  type: 'boolean',
                  description:
                    'false when the identical bytes were already stored (content-addressed)',
                },
              },
              required: ['changed'],
            },
          ],
        },
        CustodyValue: {
          type: 'object',
          description:
            'A stored entry AND its bytes — only the elevated byte-read GET returns this.',
          allOf: [
            { $ref: '#/components/schemas/CustodyEntry' },
            {
              type: 'object',
              properties: { data: { type: 'string', description: 'base64-encoded stored bytes' } },
              required: ['data'],
            },
          ],
        },
        Custody: {
          type: 'object',
          properties: {
            enabled: {
              type: 'boolean',
              description: 'false only when this hub has no custody store wired',
            },
            entries: { type: 'array', items: { $ref: '#/components/schemas/CustodyEntry' } },
          },
          required: ['enabled', 'entries'],
        },
        ProviderBake: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            baked: { type: 'boolean' },
            fingerprint: {
              type: 'string',
              description: 'Short (12-char) build-context fingerprint of the baked base',
            },
            cliVersion: { type: 'string' },
            bakedAt: { type: 'string' },
            imageRef: { type: 'string' },
            baseStatus: { type: 'string', enum: ['fresh', 'stale', 'unprepared', 'unknown'] },
            baseStaleReason: { type: 'string' },
            bakeDiff: {
              type: 'object',
              description:
                'Which files differ, when baseStatus is stale. hasManifest:false means the base was baked before per-file manifests were recorded, so no diff is possible without a re-bake.',
              properties: {
                hasManifest: { type: 'boolean' },
                liveUnavailable: {
                  type: 'boolean',
                  description:
                    'A manifest exists but the current hashes could not be computed, so no diff is possible. Distinct from hasManifest:false, where a re-bake would help.',
                },
                changed: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      rel: { type: 'string' },
                      from: { type: 'string' },
                      to: { type: 'string' },
                    },
                  },
                },
                added: { type: 'array', items: { type: 'string' } },
                removed: { type: 'array', items: { type: 'string' } },
              },
              required: ['hasManifest'],
            },
          },
          required: ['id', 'label', 'baked'],
        },
        System: {
          type: 'object',
          properties: {
            hub: {
              type: 'object',
              properties: {
                version: { type: ['string', 'null'] },
                commit: { type: ['string', 'null'] },
                profile: { type: 'string' },
                apiVersion: { type: 'string' },
              },
              required: ['profile', 'apiVersion'],
            },
            build: {
              type: 'object',
              properties: {
                version: { type: ['string', 'null'] },
                channel: {
                  type: ['string', 'null'],
                  description: 'stable | nightly | source (<ref>)',
                },
                build: {
                  type: ['string', 'null'],
                  description: 'Human build line, e.g. @madarco/agentbox@0.28.0 (npm)',
                },
              },
            },
            deploy: {
              type: ['object', 'null'],
              description: 'Present only when this machine is an exposed/deployed control box.',
            },
            providers: { type: 'array', items: { $ref: '#/components/schemas/ProviderBake' } },
            hostCarried: {
              type: 'array',
              description:
                'Agent configs, skills and identity files THIS machine hands to a box. Present-only: a path absent here is one a box will not receive.',
              items: {
                type: 'object',
                properties: {
                  agent: { type: 'string' },
                  label: { type: 'string' },
                  hostPath: { type: 'string' },
                  kind: { type: 'string', enum: ['skills', 'config', 'identity'] },
                  skills: { type: 'array', items: { type: 'string' } },
                },
                required: ['agent', 'label', 'hostPath', 'kind'],
              },
            },
            boxImage: {
              type: ['object', 'null'],
              description:
                'Box-image resolution: the registry, the exact fingerprint-tag this host pulls, and what it last stamped.',
              properties: {
                registry: { type: 'string' },
                pullTag: { type: 'string' },
                stampedFingerprint: { type: 'string' },
                imageRef: { type: 'string' },
                bakedAt: { type: 'string' },
              },
            },
          },
          required: ['hub', 'build', 'providers', 'hostCarried'],
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  enum: [
                    'invalid_request',
                    'unauthorized',
                    'not_found',
                    'conflict',
                    'manager_unreachable',
                    'wrong_host',
                    'backend_unavailable',
                    'internal',
                  ],
                },
                message: { type: 'string' },
                details: {
                  type: 'object',
                  description:
                    'Machine-readable context for the codes that carry it. `wrong_host` and `manager_unreachable` carry `host`: the machine the op has to run on. A refusal about a WORKSPACE (start, sessions) also carries `hosts` — every machine with a checkout of it — because a workspace mapped from several machines has no single right answer, and `host` is only the first of them. Retry against the hub on your own machine when it is `host` or is in `hosts`.',
                  properties: {
                    host: { type: 'string' },
                    hosts: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              required: ['code', 'message'],
            },
          },
          required: ['error'],
        },
        Box: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            managerId: {
              type: 'string',
              description:
                'The manager session that created this box. Absent for a box made from the web UI or the tray, and on a hosted hub.',
            },
            projectId: { type: 'string' },
            repo: { type: 'string' },
            branch: { type: 'string' },
            task: { type: 'string' },
            agent: { type: 'string' },
            status: { type: 'string', enum: ['running', 'paused', 'stopped', 'creating', 'error'] },
            createdAt: { type: 'number' },
            lastActivity: { type: 'number' },
            host: { type: 'string' },
            commits: { type: ['number', 'null'] },
            filesTouched: { type: ['number', 'null'] },
            error: { type: ['string', 'null'] },
            displayName: {
              type: ['string', 'null'],
              description: 'Cosmetic user-set label (rename); null when unset',
            },
            webUrl: {
              type: ['string', 'null'],
              description:
                'Host-openable web-service URL; null when absent/unreachable (e.g. paused)',
            },
            vncUrl: {
              type: ['string', 'null'],
              description: 'Host-openable VNC desktop URL; null when absent/unreachable',
            },
            state: {
              type: 'string',
              enum: ['running', 'paused', 'stopped', 'missing'],
              description:
                'Raw provider runtime state (host topology only). Absent on synthetic creating/error rows — presence distinguishes a real box whose agent errored from a failed create job.',
            },
            name: { type: 'string' },
            provider: {
              type: 'string',
              description: "Raw provider id ('docker', 'daytona', …; plugin ids possible)",
            },
            projectRoot: {
              type: 'string',
              description:
                'Absolute host path of the project. Host topology only — never emitted by the hosted plane',
            },
            projectIndex: { type: 'number' },
            vncEnabled: { type: 'boolean' },
            gitWorktrees: {
              type: 'array',
              items: {
                type: 'object',
                properties: { kind: { type: 'string' }, branch: { type: 'string' } },
              },
            },
            hasGit: {
              type: 'boolean',
              description:
                'Does the box workspace have a git repo at all? `false` means there is no worktree and no branch, and a client should HIDE its git UI (pull/push/checkout would all fail). Derived host-side on read from the recorded worktrees, else a `.git` probe of the project root, so cloud boxes — which record no worktrees — answer correctly. ABSENT is not `false`: the hosted plane and synthetic creating/error rows say nothing, and silence must be read as "show".',
            },
            supportsBackup: {
              type: 'boolean',
              description:
                "The box's agent declares a state backup, so `POST /boxes/{id}/backup` captures its IDENTITY (gateway token, pairings, history) and not just a workspace. Present for a service bot (openclaw); absent for a coding-agent box.",
            },
            pr: {
              type: 'object',
              description:
                "The box's pull request: matched in its workspace timeline by box id, else by the box branch against the PR head; the newest wins, an open one over a merged or closed one. `state` is the last GitHub sync's when the hub has one, else the log's. ABSENT means no data: no known PR, no workspace, or the hosted plane.",
              properties: {
                repo: { type: 'string', description: '`owner/name`.' },
                number: { type: 'number' },
                url: { type: 'string' },
                state: { type: 'string', enum: ['open', 'ready', 'merged', 'closed'] },
              },
              required: ['repo', 'number', 'state'],
            },
            agentStatus: {
              type: 'object',
              description:
                "Every agent reporting in this box, keyed by agent id. The source of truth; the named fields below are its projection over the three built-ins, kept for older clients. An agent outside those three appears only here. Each value is { state, sessionTitle? }, where state is 'working | idle | waiting | end-plan | question | compacting | error | unknown'.",
              additionalProperties: {
                type: 'object',
                properties: {
                  state: { type: 'string' },
                  sessionTitle: { type: 'string' },
                },
              },
            },
            claudeSessionTitle: { type: 'string' },
            codexSessionTitle: { type: 'string' },
            opencodeSessionTitle: { type: 'string' },
            claudeActivity: {
              type: 'string',
              description:
                'working | idle | waiting | end-plan | question | compacting | error | unknown',
            },
            codexActivity: { type: 'string' },
            opencodeActivity: { type: 'string' },
            shellCount: {
              type: 'number',
              description: 'Live shell-session count (docker only); absent → the CLI renders "-".',
            },
            sandboxId: {
              type: 'string',
              description:
                'Provider-native sandbox id (cloud boxes). Part of the non-secret adoption block a thin client rebuilds a drivable local record from — tokens are never serialized, a fresh adoption re-mints them.',
            },
            originUrl: {
              type: ['string', 'null'],
              description:
                "Box repo's origin remote URL. Lets project-scoped `ls` match a box to the cwd repo by identity when its projectRoot is a remote hub's path. Populated for any registered box, docker included.",
            },
            publicHost: {
              type: 'string',
              description:
                'Public IP/host of the box VM (direct-SSH providers: hetzner/digitalocean).',
            },
            image: {
              type: 'string',
              description: 'Base image / snapshot ref the sandbox booted from.',
            },
            webPort: {
              type: 'number',
              description: 'In-box WebProxy port (cloud boxes bind a non-privileged port).',
            },
            previewUrls: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Token-authed preview URLs keyed by in-box port.',
            },
            lastAgent: {
              type: 'string',
              enum: ['claude', 'codex', 'opencode', 'pi'],
              description: 'The agent the box was created for.',
            },
            persistent: {
              type: 'boolean',
              description:
                "Always-on box (`--persistent` / `box.persistent`, resolved at create time): never auto-paused, never idle-lapsed, skipped by prune, and started again by the relay's boot reconcile after a host reboot. `agentbox destroy -y` refuses one without `--force`; POST /boxes/{id}/destroy has no such guard, so a client that offers destroy should confirm on this field. Absent/false = an ordinary expendable box.",
            },
            topology: {
              type: 'string',
              description: "Sync federation shape ('cloud' | 'control-plane'); absent for docker.",
            },
          },
          required: ['id', 'projectId', 'status', 'agent'],
        },
        WorkspaceProject: {
          type: 'object',
          description:
            'One project in a workspace, identified by its REPO: the same repo is a different folder on every machine, and a control box has no folder at all.',
          properties: {
            id: {
              type: 'string',
              description:
                'Hash of the normalised repo URL, or of `<host>:<folder>` for a project with no remote.',
            },
            name: { type: 'string' },
            repoUrl: { type: 'string', description: 'The `origin` remote, as the scanner saw it.' },
          },
          required: ['id', 'name'],
        },
        WorkspaceHost: {
          type: 'object',
          description: "One machine's folders for a workspace.",
          properties: {
            root: { type: 'string', description: 'Absolute folder path on that machine.' },
            projectRoots: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Project id -> absolute path on that machine.',
            },
            seenAt: { type: 'string' },
          },
          required: ['root', 'projectRoots', 'seenAt'],
        },
        Workspace: {
          type: 'object',
          description:
            'One or more projects grouped together, owning a task list and its managers. Machine-independent: `projects` are repos and `hosts` maps each machine that has a checkout to its folders.',
          properties: {
            id: { type: 'string', description: 'Random 16 hex; NOT derived from a path.' },
            name: { type: 'string' },
            projects: {
              type: 'array',
              items: { $ref: '#/components/schemas/WorkspaceProject' },
            },
            hosts: {
              type: 'object',
              additionalProperties: { $ref: '#/components/schemas/WorkspaceHost' },
              description: 'Keyed by `os.hostname()` of the machine holding the folders.',
            },
            root: {
              type: 'string',
              description:
                "This HUB's own folder for the workspace; absent when it has no checkout.",
            },
            projectIds: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Every project id a client may hold: the repo-keyed ids, plus the path hash of each folder the hub itself has (what a box record and `GET /projects` key by).',
            },
            taskCounts: {
              type: 'object',
              properties: { open: { type: 'number' }, done: { type: 'number' } },
              required: ['open', 'done'],
            },
            managers: {
              type: 'object',
              description: 'How many manager sessions this workspace has, and how many run now.',
              properties: { running: { type: 'number' }, total: { type: 'number' } },
              required: ['running', 'total'],
            },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
          // Every route that serves a workspace serves the derived counts with it.
          required: [
            'id',
            'name',
            'projects',
            'hosts',
            'projectIds',
            'taskCounts',
            'managers',
            'createdAt',
            'updatedAt',
          ],
        },
        WorkTaskExternalRef: {
          type: 'object',
          description:
            'Back-reference to an external tracker. One ticket routinely becomes several tasks.',
          properties: {
            kind: { type: 'string', example: 'linear' },
            id: { type: 'string' },
            url: { type: 'string' },
          },
          required: ['kind', 'id'],
        },
        TimelinePr: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: '`owner/name`.' },
            number: { type: 'number' },
            title: { type: 'string' },
            url: { type: 'string' },
            base: { type: 'string' },
            head: { type: 'string' },
            additions: { type: 'number' },
            deletions: { type: 'number' },
            checks: { type: 'string', enum: ['pass', 'fail', 'pending', 'none'] },
            mergeState: { type: 'string' },
            autoMerge: { type: 'boolean' },
            mergedBy: { type: 'string' },
          },
          required: ['repo', 'number', 'title', 'url', 'base', 'head'],
        },
        TimelineEvent: {
          type: 'object',
          description: "One line of a workspace's append-only timeline log.",
          properties: timelineEventProperties,
          required: ['id', 'at', 'type', 'actor'],
        },
        TimelineEventInput: {
          type: 'object',
          description:
            'An event another hub forwards into this workspace. Same fields as `TimelineEvent` minus `id` (minted here) and with `actor` limited to the three a forwarder may claim.',
          properties: {
            ...timelineEventInputProperties,
            actor: { type: 'string', enum: ['box', 'hub', 'manager'] },
            at: {
              type: 'string',
              description:
                'ISO time the event happened. Honoured, so a late forward is ordered by when it happened rather than when it arrived; stamped on arrival when absent.',
            },
            key: {
              type: 'string',
              description:
                'Dedupe key: an append carrying a key already in the log is a no-op (200, not 201).',
            },
          },
          required: ['type', 'actor'],
        },
        TimelineBranchUrl: {
          type: 'string',
          description:
            "The row's branch on the web, e.g. `https://github.com/acme/storefront-web/tree/feat/checkout-copy`, each branch segment URL-encoded. Added at read time, never stored. Present only when the row names a branch (`pr.head` on a PR row, else `branch`) and its repo is known: from `pr.url`, else a repo the GitHub sync resolved, else the row's project or box repo as the last sync cached it.",
        },
        TimelineLane: {
          type: 'object',
          description:
            'Where a row sits when the timeline is drawn as a branch graph. Assigned at read time over the whole log before paging, so a lane keeps its id on every page; set on every item and live row.',
          properties: {
            id: {
              type: 'string',
              description:
                '`trunk`, `box:<boxId>`, or `branch:<head>` for a pull request no box is known to own.',
            },
            kind: { type: 'string', enum: ['trunk', 'box', 'branch'] },
            from: {
              type: 'string',
              description:
                "On the lane's oldest row: the lane it forked from (the box lane that last carried its `base`, else `trunk`). Absent on a page that does not reach the fork.",
            },
            into: {
              type: 'string',
              description:
                '`pr.merged`: the lane it merged into (the box lane carrying `pr.base`, else `trunk`). The row stays on its own lane.',
            },
            branch: {
              type: 'string',
              description: "The lane's branch, on its first row and on every row where it changes.",
            },
            open: {
              type: 'boolean',
              description:
                "On the lane's live rows and its newest item when the lane goes on: a live row exists, or the box still exists and is running or has unmerged work.",
            },
          },
          required: ['id', 'kind'],
        },
        TimelineItem: {
          type: 'object',
          description:
            'A timeline row: an event, or a `plan` that 3+ `task.created` events from one manager turn collapsed into.',
          properties: {
            ...timelineEventProperties,
            type: { type: 'string', enum: [...timelineEventTypes, 'plan'] },
            count: { type: 'number', description: '`plan`: how many tasks it created.' },
            approvedByYou: {
              type: 'boolean',
              description: '`pr.merged`: a message about this PR was sent before it merged.',
            },
            branchUrl: { $ref: '#/components/schemas/TimelineBranchUrl' },
            lane: { $ref: '#/components/schemas/TimelineLane' },
          },
          required: ['id', 'at', 'type', 'actor'],
        },
        TimelineLiveItem: {
          type: 'object',
          description: 'A row true right now, built at read time.',
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: ['task.in_progress', 'pr.ready'] },
            at: { type: 'string' },
            boxId: { type: 'string' },
            boxName: { type: 'string' },
            agent: { type: 'string' },
            branch: { type: 'string' },
            branchUrl: { $ref: '#/components/schemas/TimelineBranchUrl' },
            managerId: { type: 'string' },
            task: {
              type: 'object',
              properties: { id: { type: 'string' }, title: { type: 'string' } },
              required: ['id', 'title'],
            },
            taskIds: { type: 'array', items: { type: 'string' } },
            filesChanged: { type: 'number' },
            additions: { type: 'number' },
            deletions: { type: 'number' },
            pr: { $ref: '#/components/schemas/TimelinePr' },
            awaiting: { type: 'boolean' },
            approved: { type: 'boolean' },
            lane: { $ref: '#/components/schemas/TimelineLane' },
          },
          required: ['id', 'type', 'at'],
        },
        TimelineSummary: {
          type: 'object',
          properties: {
            since: { type: 'string' },
            merged: { type: 'number' },
            additions: { type: 'number' },
            deletions: { type: 'number' },
            tasksDone: { type: 'number' },
            awaiting: {
              type: 'number',
              description:
                "Ready PRs not approved yet, plus pending approvals on the workspace's boxes.",
            },
          },
          required: ['since', 'merged', 'additions', 'deletions', 'tasksDone', 'awaiting'],
        },
        Timeline: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/TimelineItem' } },
            live: { type: 'array', items: { $ref: '#/components/schemas/TimelineLiveItem' } },
            summary: { $ref: '#/components/schemas/TimelineSummary' },
            github: {
              type: 'string',
              enum: ['ok', 'syncing', 'unavailable'],
              description:
                '`unavailable`: no gh, not logged in, or no GitHub repo behind the workspace.',
            },
          },
          required: ['items', 'live', 'github'],
        },
        WorkTask: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^T-\\d+$' },
            workspaceId: { type: 'string' },
            projectId: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done'] },
            order: {
              type: 'number',
              description: 'Position in the list; the order IS the priority.',
            },
            boxId: { type: 'string' },
            boxJobId: {
              type: 'string',
              description: 'A create job that has not produced a box yet; healed to boxId on read.',
            },
            managerId: {
              type: 'string',
              description:
                'The manager session this task belongs to. Set by `agentbox tasks add` inside a session, and inherited from the box on assignment.',
            },
            dependsOn: { type: 'array', items: { type: 'string' } },
            createdBy: { type: 'string', enum: ['human', 'manager', 'api'] },
            externalRef: { $ref: '#/components/schemas/WorkTaskExternalRef' },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
            doneAt: { type: 'string' },
          },
          required: [
            'id',
            'workspaceId',
            'title',
            'status',
            'order',
            'createdBy',
            'createdAt',
            'updatedAt',
          ],
        },
        Manager: {
          type: 'object',
          description: 'A host agent session that creates and watches boxes. Many per workspace.',
          properties: {
            id: { type: 'string', pattern: '^[0-9a-f]{16}$' },
            workspaceId: { type: 'string' },
            workspaceName: { type: 'string' },
            agent: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['external', 'tmux', 'pty'],
              description:
                "`external`: a session in someone's own terminal, only observed. `pty`: one a hub started on an AgentBox pty host on `host` — what a start produces, and what `ptyAttach` opens. `tmux`: the same thing on the older tmux carrier, used when this install cannot run a pty host. Both hub-run kinds can be attached to and stopped there.",
            },
            status: { type: 'string', enum: ['running', 'stopped'] },
            resumable: {
              type: 'boolean',
              description:
                'Whether a resume would be accepted at all: false while it runs, without a session id, and for an agent whose sessions cannot be resumed. Says nothing about WHERE — that is `hostIsHub`. A GUI disables Resume on false, or when `hostIsHub` is false and it cannot reach a hub on `host`.',
            },
            resumeBlockedBy: {
              type: 'string',
              enum: ['running', 'unsupported-agent', 'no-session'],
              description:
                'Why `resumable` is false, in the order a resume checks: `running`, `no-session` (no session id yet), `unsupported-agent`. Absent when `resumable` is true.',
            },
            cwd: {
              type: 'string',
              description: 'Folder the session runs in; a resume runs there.',
            },
            sessionId: { type: 'string' },
            title: { type: 'string', description: "The session's first user turn, when readable." },
            host: {
              type: 'string',
              description:
                'os.hostname() of the machine the session runs on. Every process op (start, resume, attach, stop, sessions, message) only works on a hub running there; anywhere else it answers 409 `wrong_host` with `details.host` naming this machine, and the client retries against the hub on it.',
            },
            hostIsHub: {
              type: 'boolean',
              description:
                'Whether the hub that answered IS that machine. False means its state came from the last heartbeat, and a process op must go elsewhere.',
            },
            pid: { type: 'number' },
            pidStartedAt: {
              type: 'string',
              description:
                "The pid's start time (`ps -o lstart=`), recorded when the session reported the hub's own host. A live pid with a different start time is a reused pid, and the manager reads as stopped.",
            },
            tmuxSession: { type: 'string' },
            tmuxPane: {
              type: 'string',
              description:
                "External only: the tmux pane the session's terminal reported, where a message can be typed.",
            },
            attachCommand: {
              type: 'string',
              description:
                "Ready-to-run attach command: `agentbox manager attach <id>` for a pty manager, the tmux attach for a tmux one, or the hub's attach session for a Claude background session while it is up.",
            },
            ptyAttach: {
              type: 'object',
              description:
                'How to open a running `pty` manager: `command` is an absolute argv a client execs (so an embedding app needs nothing on its login PATH), `socket` its unix socket and `protocol` the frame protocol version. Only present on the machine that runs it.',
              properties: {
                command: { type: 'array', items: { type: 'string' } },
                socket: { type: 'string' },
                protocol: { type: 'number' },
              },
            },
            pinned: {
              type: 'boolean',
              description:
                'Keep the session running even when no client holds a lease on it. Without a pin, a session a client leased is stopped once that client stays away past the grace window.',
            },
            background: {
              type: 'object',
              description:
                "A claude manager whose session is a detached Claude Code background session (`claude --bg`, listed by `claude agents`): running in Claude's daemon and shown by nothing the hub can see. POST /managers/{id}/attach opens it. The manager is `running` while the session is, whatever else is attached. Read from `claude agents --json --all` at most every 15 s.",
              properties: {
                id: { type: 'string', description: 'The short id `claude attach` takes.' },
                status: { type: 'string', description: '`busy`, `idle`, `waiting`, …' },
                state: { type: 'string', description: '`working`, `done`, …' },
                name: { type: 'string' },
              },
              required: ['id'],
            },
            terminalSession: {
              type: 'string',
              description:
                "A running external manager's likely terminal: the one AgentBox tmux session (`agentbox-manager-*`) that started in its folder and no manager owns, such as a session from before managers were detected. A guess, never adopted: a client may offer to open it (`tmux attach -t =<name>`).",
            },
            boxIds: { type: 'array', items: { type: 'string' } },
            boxJobIds: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Create jobs that have not produced a box yet; healed to boxIds on read.',
            },
            taskCounts: {
              type: 'object',
              properties: { open: { type: 'number' }, done: { type: 'number' } },
              required: ['open', 'done'],
            },
            createdAt: { type: 'string' },
            lastSeenAt: { type: 'string' },
            startedAt: { type: 'string' },
            stoppedAt: { type: 'string' },
            lastExit: {
              type: 'number',
              description: "A hub-run agent's own exit code, when it ended on its own.",
            },
          },
          required: [
            'id',
            'workspaceId',
            'workspaceName',
            'agent',
            'kind',
            'host',
            'hostIsHub',
            'status',
            'resumable',
            'cwd',
            'boxIds',
            'boxJobIds',
            'taskCounts',
            'createdAt',
            'lastSeenAt',
          ],
        },
        HostSession: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            agent: { type: 'string' },
            title: { type: 'string', description: 'First user turn of the transcript.' },
            updatedAt: { type: 'string' },
          },
          required: ['id', 'agent', 'title', 'updatedAt'],
        },
        Project: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            repo: { type: 'string' },
            defaultBranch: { type: 'string' },
            currentBranch: { type: 'string', nullable: true },
            needsSetup: {
              type: 'boolean',
              description:
                'No agentbox.yaml + no default snapshot — the create form offers the setup wizard',
            },
            provider: { type: 'string' },
            createdAt: { type: 'number' },
            originUrl: {
              type: 'string',
              nullable: true,
              description: 'Repo origin remote URL (hosted source only)',
            },
            projectSlug: {
              type: 'string',
              nullable: true,
              description: 'Custody projects/<slug> key (hosted source only)',
            },
            lastProvider: {
              type: 'string',
              nullable: true,
              description:
                "The provider this project's last box was created with — the pre-selection a create picker should open on. Advisory, not a contract: it may be a `docker:<alias>` remote-docker spec, and it may name a provider that is not configured (or no longer exists) on this host, so clamp it against GET /providers and fall back to docker. Absent until a create has been recorded.",
            },
            lastAgent: {
              type: 'string',
              nullable: true,
              description:
                'The agent that box was created for, as a create-picker default. Same caveats as lastProvider — clamp against GET /agents. Never `none`: an agentless create records only the provider.',
            },
            lastUsedAt: {
              type: 'number',
              nullable: true,
              description: 'Epoch ms of the create those two fields describe.',
            },
          },
          required: ['id', 'name'],
        },
        PromptRequest: {
          type: 'object',
          description:
            'One question to put to the user. The generic half (`kind`, `title`, `body`, `choices`) is enough to render and answer ANY prompt, including one this client has never seen. `detail` is the opt-in half: a client that recognises the variant draws it properly (a file table, a credential card) and one that does not renders its `summary`.',
          required: ['id', 'topic', 'kind', 'title', 'fallback'],
          properties: {
            id: {
              type: 'string',
              description:
                'Content-addressed over the question itself (`<topic>:<digest>`). Echo it back in the answer; if the question has since changed the id no longer matches and the create refuses rather than applying an answer to a different question.',
            },
            topic: {
              type: 'string',
              description: 'Machine-stable reason this prompt exists: `carry`, `model-auth`.',
            },
            kind: { type: 'string', enum: ['confirm', 'select', 'text'] },
            title: { type: 'string' },
            body: { type: 'string' },
            choices: {
              type: 'array',
              description: 'Required for `select`.',
              items: {
                type: 'object',
                required: ['value', 'label'],
                properties: {
                  value: { type: 'string' },
                  label: { type: 'string' },
                  hint: { type: 'string' },
                  danger: { type: 'boolean' },
                  exclusive: {
                    type: 'boolean',
                    description:
                      'In a `multiple` select, means "none of the others". Ignored otherwise.',
                  },
                },
              },
            },
            multiple: {
              type: 'boolean',
              description:
                '`select` only: several choices may be picked, and the answer is their values joined by `,`. A client that does not know the flag renders a plain single select and posts ONE value, which is the n=1 encoding of the same answer.',
            },
            defaultValue: { type: 'string' },
            detail: {
              type: 'object',
              description:
                'Typed extra content, discriminated by `type` (`file-table` | `credential` | `credential-list` | `text`). Every variant carries `summary`, so an unknown one still renders.',
              required: ['type', 'summary'],
              properties: { type: { type: 'string' }, summary: { type: 'string' } },
              additionalProperties: true,
            },
            fallback: {
              type: 'object',
              description: 'What happens if nobody answers.',
              required: ['value', 'reason'],
              properties: { value: { type: 'string' }, reason: { type: 'string' } },
            },
            required: {
              type: 'boolean',
              description:
                'No safe fallback: a create that leaves this unanswered is refused rather than defaulted.',
            },
            nonInteractiveHint: {
              type: 'string',
              description: 'The flags or env vars that decide this question up front.',
            },
          },
        },
        CreatePreflight: {
          type: 'object',
          required: ['prompts', 'unavailable'],
          properties: {
            prompts: { type: 'array', items: { $ref: '#/components/schemas/PromptRequest' } },
            unavailable: {
              type: 'array',
              description: 'Gates this hub cannot run, and why.',
              items: {
                type: 'object',
                required: ['topic', 'reason'],
                properties: { topic: { type: 'string' }, reason: { type: 'string' } },
              },
            },
          },
        },
        ProjectSeed: {
          type: 'object',
          properties: {
            custodyAvailable: {
              type: 'boolean',
              description: 'False when this hub is not a control box (no custody store)',
            },
            seed: {
              type: 'object',
              nullable: true,
              description: 'Null when nothing has been pushed for this project.',
              properties: {
                slug: { type: 'string' },
                originUrl: { type: 'string' },
                baseBranch: { type: 'string' },
                repoHeadSha: { type: 'string', description: 'Full commit the working tree sat on' },
                capturedAt: { type: 'string', description: 'ISO timestamp of the last seed push' },
                hasEnv: { type: 'boolean', description: 'env/secret tarball present' },
                hasUntracked: { type: 'boolean', description: 'untracked-files tarball present' },
                totalBytes: { type: 'number' },
                entries: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      size: { type: 'number' },
                      sha256: { type: 'string' },
                      updatedAt: { type: 'string' },
                    },
                    required: ['name', 'size', 'sha256', 'updatedAt'],
                  },
                },
              },
              required: ['slug', 'hasEnv', 'hasUntracked', 'totalBytes', 'entries'],
            },
          },
          required: ['custodyAvailable', 'seed'],
        },
        BranchList: {
          type: 'object',
          properties: {
            current: {
              type: 'string',
              nullable: true,
              description: "The repo's current HEAD (the default base ref)",
            },
            branches: {
              type: 'array',
              items: { type: 'string' },
              description: 'Local + remote-tracking branch names',
            },
          },
          required: ['branches'],
        },
        Approval: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            boxId: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['confirm', 'select', 'text', 'open-link'],
              description:
                'Which widget to draw; absent means `confirm`. `open-link` is not a question: it carries a `url` the client is asked to open on ITS OWN machine, answering with `openedByClient: true` so the host does not open a second copy (on a control box that would be a tab nobody can see). A client that cannot open URLs may answer a plain `y` and let the host try.',
            },
            message: { type: 'string' },
            detail: { type: 'string' },
            command: { type: 'string' },
            cwd: { type: 'string' },
            argv: { type: 'array', items: { type: 'string' } },
            defaultAnswer: { type: 'string', enum: ['y', 'n'] },
            createdAt: { type: 'number' },
            url: { type: 'string', description: '`open-link` only: the http(s) URL to open.' },
            autoOpen: {
              type: 'boolean',
              description:
                '`open-link` only: the host already approved this link (safe subset + rate budget), so a client that can open URLs should claim it and open it without asking. Absent means a human has to act.',
            },
          },
          required: ['id', 'boxId', 'message', 'defaultAnswer'],
        },
        Job: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] },
            boxId: { type: 'string' },
            error: {
              type: 'string',
              description:
                "A failed job's reason — so a create reports the failure, not a silent 'done'.",
            },
            provider: { type: 'string' },
            name: { type: 'string' },
            agent: { type: 'string' },
            createdAt: { type: 'string' },
            login: {
              type: 'object',
              description:
                'Present when the create is awaiting a Claude re-login (see POST /jobs/{id}/login-code).',
              properties: {
                required: { type: 'boolean' },
                phase: { type: 'string' },
                url: { type: 'string' },
                error: { type: 'string' },
                lastError: { type: 'string' },
              },
            },
          },
          required: ['id', 'status'],
        },
        JobListItem: {
          type: 'object',
          description: 'One row of GET /jobs — the Job shape without the streamable log path.',
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] },
            boxId: { type: 'string' },
            error: { type: 'string' },
            provider: { type: 'string' },
            name: { type: 'string' },
            agent: { type: 'string' },
            createdAt: { type: 'string' },
          },
          required: ['id', 'status'],
        },
        AgentState: {
          type: 'object',
          description:
            "The box's in-box agent status snapshot. `agents` holds every reporting agent keyed by id (each the raw ctl status payload: activity, plan/question, session title) and is the source of truth. `claude` repeats that agent's body for clients older than `agents`; null when claude has no snapshot, which includes a box running a different agent.",
          properties: {
            agents: {
              type: 'object',
              description: 'Raw per-agent status payloads, keyed by agent id (opaque here).',
              additionalProperties: true,
            },
            claude: { description: "Claude's body, repeated from `agents` (opaque here)." },
          },
          required: ['claude'],
        },
        CheckpointCreateResult: {
          type: 'object',
          properties: {
            ok: { const: true },
            name: { type: 'string' },
            kind: {
              type: 'string',
              description:
                "docker manifest type ('layered' | 'merged') or 'snapshot' for a cloud backend.",
            },
            ref: { type: 'string', description: 'The image tag / snapshot id created.' },
            provider: { type: 'string' },
            dir: { type: 'string', description: 'Snapshot dir (cloud backends).' },
            setDefaultKey: {
              type: 'string',
              description: 'The config key written when setDefault was requested.',
            },
          },
          required: ['ok', 'name', 'kind', 'ref', 'provider'],
        },
        CheckpointItem: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            provider: { type: 'string', description: "'docker' or the cloud backend name." },
            kind: { type: 'string' },
            sourceBoxName: { type: 'string' },
            createdAt: { type: 'string' },
            isDefault: {
              type: 'boolean',
              description: "Resolved server-side against the project's effective config.",
            },
          },
          required: ['name', 'provider', 'kind', 'isDefault'],
        },
        CheckpointListing: {
          type: 'object',
          properties: {
            projects: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  segment: { type: 'string', description: 'The path-hash store segment.' },
                  projectRoot: {
                    type: 'string',
                    description: 'Absent for an orphan segment whose project config was GC-ed.',
                  },
                  label: { type: 'string' },
                  items: { type: 'array', items: { $ref: '#/components/schemas/CheckpointItem' } },
                },
                required: ['segment', 'label', 'items'],
              },
            },
          },
          required: ['projects'],
        },
        CheckpointRemoveResult: {
          type: 'object',
          properties: {
            ok: { const: true },
            removed: {
              type: 'array',
              items: { type: 'string' },
              description: 'Providers the checkpoint was deleted from.',
            },
            clearedKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'Default-checkpoint config pointers cleared in the project layer.',
            },
            warnedKeys: {
              type: 'array',
              items: { type: 'string' },
              description: "Dangling pointers in a layer we can't auto-edit (warned, not cleared).",
            },
          },
          required: ['ok', 'removed', 'clearedKeys', 'warnedKeys'],
        },
        PruneResult: {
          description:
            'The prune outcome — discriminated by `kind`: `general` (docker sweep), `cloud` (untracked cloud sandboxes).',
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { const: 'general' },
                result: {
                  type: 'object',
                  properties: {
                    removedRecords: { type: 'array', items: { type: 'string' } },
                    removedContainers: { type: 'array', items: { type: 'string' } },
                    removedVolumes: { type: 'array', items: { type: 'string' } },
                    removedSnapshotDirs: { type: 'array', items: { type: 'string' } },
                    removedBoxDirs: { type: 'array', items: { type: 'string' } },
                    removedCheckpointImages: { type: 'array', items: { type: 'string' } },
                    dryRun: { type: 'boolean' },
                  },
                  required: ['dryRun'],
                },
                projectConfigs: { type: 'array', items: { type: 'string' } },
              },
              required: ['kind', 'result', 'projectConfigs'],
            },
            {
              type: 'object',
              properties: {
                kind: { const: 'cloud' },
                provider: { type: 'string' },
                dryRun: { type: 'boolean' },
                orphans: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      sandboxId: { type: 'string' },
                      name: { type: 'string' },
                      state: { type: 'string' },
                      createdAt: { type: 'string' },
                    },
                    required: ['sandboxId'],
                  },
                },
                deleted: { type: 'number' },
                failed: { type: 'number' },
                reaped: {
                  type: 'number',
                  description:
                    'Control-box registrations reaped for the deleted sandboxes (0 on a dry run).',
                },
              },
              required: ['kind', 'provider', 'dryRun', 'orphans', 'deleted', 'failed', 'reaped'],
            },
          ],
        },
        CreateBox: {
          type: 'object',
          properties: {
            projectId: {
              type: 'string',
              description:
                'Project to build from. Exactly one of projectId / repoUrl. A projectId whose folder is absent on this machine (the normal case on a control box) routes to the control-plane clone queue.',
            },
            repoUrl: {
              type: 'string',
              description:
                "Repo origin to clone from, when the project has no folder on the hub's machine. Exactly one of projectId / repoUrl.",
            },
            agent: {
              type: 'string',
              description:
                'Canonical agent id, or "none" for a plain box with no agent. Open-ended: the built-ins are claude | codex | opencode | pi | openclaw, plus anything registered by `agentbox agent add` — GET /agents is the live list this route validates against.',
              example: 'claude',
            },
            agentArgs: {
              type: 'array',
              items: { type: 'string' },
              description: "Extra argv passed to the agent's launcher.",
            },
            startAgent: {
              type: 'boolean',
              description: 'Start the agent session after the box is built (default true).',
            },
            foreground: {
              type: 'boolean',
              description:
                "An interactive create — the hub runs it in the ungated foreground lane so it doesn't queue behind background jobs.",
            },
            managerId: {
              type: 'string',
              pattern: '^[0-9a-f]{16}$',
              description:
                'The manager session this create came from (`POST /managers/detect` returns it). The job is attached to it, so the box reports that `managerId`.',
            },
            opts: {
              type: 'object',
              additionalProperties: true,
              description:
                "Box-shaping knobs the caller already resolved (image, snapshot, limits, size/location, carry, credential-sync, ...), so a hub-routed create builds the same box an inline one would. Absent keys fall back to the hub's own config.",
              properties: {
                persistent: {
                  type: 'boolean',
                  description:
                    "Always-on box: never auto-paused, never idle-lapsed, skipped by prune, restarted after a host reboot. OMIT for no opinion — a service agent then defaults to `true` and everything else to the hub's `box.persistent`. `true` on e2b/vercel is refused with `conflict`.",
                },
                promptAnswers: {
                  type: 'array',
                  description:
                    'Answers to the questions POST /projects/{id}/create-preflight returned. Each `id` is matched against the question the create actually asks, so a stale answer is ignored rather than applied. Omitting an answer to a `required` prompt fails the create.',
                  items: {
                    type: 'object',
                    required: ['id', 'value'],
                    properties: {
                      id: { type: 'string' },
                      value: { type: 'string' },
                      cancelled: { type: 'boolean' },
                    },
                  },
                },
                carryYes: {
                  type: 'boolean',
                  description:
                    "Approve the project's `carry:` block without asking — the API twin of `--carry-yes`. Use it instead of `promptAnswers` when the decision is already made (a scripted create, a clone): the create then needs no terminal. Per-run, so it leaves no standing approval behind.",
                },
                carrySkip: {
                  type: 'boolean',
                  description:
                    "Decline the project's `carry:` block without asking — the API twin of `--carry skip`. A decline has to be sayable rather than merely absent: an omitted answer to the `required` carry prompt fails the create, so without this a scripted skip could not get through. Leaves any standing approval intact.",
                },
                borrowCredentials: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    "Other agents' host logins to seed as this box's model auth (`--model-auth`; service agents). Normally decided by the `model-auth` prompt instead.",
                },
              },
            },
            provider: {
              type: 'string',
              enum: [
                'docker',
                'daytona',
                'hetzner',
                'vercel',
                'e2b',
                'digitalocean',
                'remote-docker',
              ],
              default: 'docker',
            },
            name: { type: 'string' },
            prompt: { type: 'string' },
            fromBranch: {
              type: 'string',
              description:
                "Base ref the box's per-box branch forks from (branch / tag / SHA); default the project's HEAD",
            },
            setupWizard: {
              type: 'boolean',
              description:
                'Seed the agent\'s first turn to generate agentbox.yaml (for projects with none). Inert for agent "none".',
            },
          },
          required: ['projectId', 'agent'],
        },
        Agent: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description:
                'Canonical agent id, as accepted by `agent` on POST /boxes. Open-ended: the ' +
                'built-ins are claude | codex | opencode | pi, plus whatever is registered.',
            },
            label: { type: 'string', description: 'Display name; falls back to the id.' },
            installed: {
              type: 'boolean',
              description:
                "This machine holds the agent's config dir or a saved AgentBox login. Absent " +
                'when the hub has no host to answer for.',
            },
            surface: {
              type: 'string',
              enum: ['tui', 'service'],
              description:
                'What the agent IS: `tui` is a session you attach to, `service` is a daemon ' +
                'the box hosts (published on the box web URL, nothing to attach to). Read it ' +
                'to show the defaults this API applies — a `service` agent creates an ' +
                'always-on box unless `opts.persistent` says otherwise, so a create form that ' +
                'renders that toggle off would contradict what POST /boxes does. Absent when ' +
                'the hub has no host to answer for; treat that as unknown, not as `tui`.',
            },
          },
          required: ['id', 'label'],
        },
        Provider: {
          type: 'object',
          description:
            'A provider plus its declarative descriptor. The descriptor half comes from a sync snapshot (the built-in table, or ~/.agentbox/plugins.json for a community provider), so it is always present and costs nothing to serve. Clients should render from it rather than hardcoding provider names.',
          properties: {
            id: {
              type: 'string',
              description:
                'Built-ins are docker, daytona, hetzner, vercel, e2b, digitalocean, remote-docker; a registered plugin uses its own name.',
            },
            label: { type: 'string' },
            configured: {
              type: 'boolean',
              description: 'Base image baked (usable for create) on this host.',
            },
            kind: { type: 'string', enum: ['local', 'cloud'] },
            credentials: {
              type: 'object',
              description: 'What "configured credentials" means, and the form to prompt with.',
              properties: {
                envKeys: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'secrets.env key NAMES whose presence means configured. Values are never read.',
                },
                fields: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      key: { type: 'string' },
                      label: { type: 'string' },
                      optional: { type: 'boolean' },
                      secret: { type: 'boolean', description: 'Absent means secret — mask it.' },
                      hint: { type: 'string' },
                    },
                    required: ['key', 'label'],
                  },
                },
              },
            },
            bake: {
              type: 'object',
              properties: {
                required: {
                  type: 'boolean',
                  description:
                    'false = the base self-heals on create (docker), so a missing base is a slow first create, not a blocked one.',
                },
                approxMinutes: { type: 'string' },
                createProgressSteps: {
                  type: 'integer',
                  description:
                    'Typical streamed create-log line count, for client progress pacing.',
                },
                bakeProgressSteps: { type: 'integer' },
              },
            },
            capabilities: {
              type: 'object',
              description:
                'All DECLARED, not inferred from method presence. pauseSemantics "stop" means pause powers the box off — relabel the control, do not hide it.',
              additionalProperties: true,
            },
            sizes: {
              type: 'array',
              description:
                'Sizes to offer in a create picker, most-modest first. Each key is a literal --size value for THIS backend; there is no cross-provider grammar. Absent = the provider has no size knob (docker).',
              items: {
                type: 'object',
                properties: { key: { type: 'string' }, label: { type: 'string' } },
                required: ['key', 'label'],
              },
            },
            sizeHint: {
              type: 'string',
              description:
                'Placeholder for a free-text size. Its PRESENCE is what says `sizes` is an open list — offer a custom-value field only when there is a hint for it.',
            },
            sizeAppliesAt: {
              type: 'string',
              enum: ['create', 'bake'],
              description:
                'bake = the size is fixed when the base is baked and rejected per-create (daytona, e2b), so a change must go through POST /providers/{id}/prepare with { size, force: true } first. Absent = create. POST /providers/{id}/size-check says whether a SPECIFIC size needs that.',
            },
            regions: {
              type: 'array',
              items: {
                type: 'object',
                properties: { key: { type: 'string' }, label: { type: 'string' } },
                required: ['key', 'label'],
              },
            },
            hasCredentials: {
              type: 'boolean',
              description:
                'Credentials present (docker: always true). Can be true while not yet configured (baked).',
            },
            jobId: {
              type: 'string',
              description: 'Id of an in-flight bake (prepare) job for this provider, if any.',
            },
            reason: { type: 'string' },
            baseStatus: {
              type: 'string',
              enum: ['fresh', 'stale', 'unprepared', 'unknown'],
              description:
                'Only when ?freshness=1. stale = re-bake wanted; unknown = could not verify.',
            },
            baseStaleReason: { type: 'string' },
            origin: {
              type: 'string',
              enum: ['local', 'hub'],
              description:
                'hub = this row came from a remote control box, which is where its boxes are created.',
            },
            hubUrl: { type: 'string' },
          },
          required: ['id', 'label', 'configured'],
        },
        GitOpBody: {
          type: 'object',
          description:
            'Union of git-op fields; only those for the chosen {op} are read (extras are ignored).',
          properties: {
            branch: { type: 'string', description: 'checkout: branch to switch to' },
            name: {
              type: 'string',
              description: 'branch: new branch name (agentbox/ prefix added when missing)',
            },
            from: {
              type: 'string',
              description: "branch: base ref to fork from (default: box's HEAD)",
            },
            remote: { type: 'string', description: 'push/pull: remote name (default: origin)' },
            force: {
              type: 'boolean',
              description:
                'push: force the remote push; push-host: overwrite the destination branch',
            },
            ffOnly: { type: 'boolean', description: 'pull: pass --ff-only to the merge' },
            as: {
              type: 'string',
              description:
                "push-host: destination branch name in the host repo (default: the box's branch)",
            },
          },
        },
        GitOpResult: {
          type: 'object',
          properties: {
            ok: { const: true },
            stdout: { type: 'string' },
            stderr: { type: 'string' },
          },
          required: ['ok'],
        },
        GitInfo: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            branch: { type: 'string' },
            dirty: { type: 'boolean' },
            ahead: { type: 'number' },
            behind: { type: 'number' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        Services: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['live', 'persisted', 'unavailable'] },
            services: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  state: { type: 'string' },
                  pid: { type: ['number', 'null'] },
                  restarts: { type: 'number' },
                  lastExitCode: { type: ['number', 'null'] },
                  blockedOn: { type: 'array', items: { type: 'string' } },
                  command: { type: 'string' },
                },
                required: ['name', 'state'],
              },
            },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, state: { type: 'string' } },
                required: ['name', 'state'],
              },
            },
            ports: {
              type: 'array',
              items: {
                type: 'object',
                properties: { port: { type: 'number' }, service: { type: ['string', 'null'] } },
                required: ['port'],
              },
            },
            error: { type: 'string' },
          },
          required: ['source', 'services', 'tasks', 'ports'],
        },
      },
    },
  };
}

// Zero-build docs page: Scalar's standalone bundle renders the spec at /openapi.json.
// Loaded from a CDN (a convenience page; the API itself is fully usable without it).
export function docsHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <title>AgentBox Hub API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/api/v1/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}
