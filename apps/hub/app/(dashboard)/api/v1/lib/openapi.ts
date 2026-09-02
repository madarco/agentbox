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
            'Async — returns a job id. agent "none" just creates the box without starting an agent (prompt ignored). provider defaults to docker; a cloud provider must be configured on the host (see GET /providers). A SERVICE agent (one whose GET /agents row reports `surface: "service"`, e.g. openclaw) creates a PERSISTENT box by default — it hosts a daemon, so an autopause would be an outage; pass `opts.persistent: false` for an expendable one. A persistent create on e2b/vercel is refused with `conflict` rather than silently downgraded. KNOWN LIMITATION: the queue worker cannot yet BUILD a service-agent box — it fails the job with `unknown agent kind` — so use the CLI (`agentbox <agent>`) for one until that lands; the request itself is accepted and carries the right options.',
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
            "Exports the box's workspace files (gitignore/exclude aware, agent state dropped) into a new host project dir, then enqueues a normal create seeded from it. The agent's config volume and credential are deliberately NOT copied, so the clone onboards from scratch and gets its own identity — there is no `--with-state`. `.git` is not exported: the clone is a template, and a git-backed second box is what a plain create already gives you. Returns the create job; stream it via GET /jobs/{jobId}/logs. Backs `agentbox clone`.",
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
                        "Host dir for the clone's workspace (default `~/.agentbox/clones/<name>`). Must be absent or empty.",
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
          summary: 'Register a folder as a project',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'Absolute path to the folder.' },
                  },
                  required: ['path'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Registered',
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
              schema: {
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
              },
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
              schema: {
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
              },
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
              properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
              required: ['code', 'message'],
            },
          },
          required: ['error'],
        },
        Box: {
          type: 'object',
          properties: {
            id: { type: 'string' },
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
            topology: {
              type: 'string',
              description: "Sync federation shape ('cloud' | 'control-plane'); absent for docker.",
            },
          },
          required: ['id', 'projectId', 'status', 'agent'],
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
          },
          required: ['id', 'name'],
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
            message: { type: 'string' },
            detail: { type: 'string' },
            command: { type: 'string' },
            cwd: { type: 'string' },
            argv: { type: 'array', items: { type: 'string' } },
            defaultAnswer: { type: 'string', enum: ['y', 'n'] },
            createdAt: { type: 'number' },
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
          },
          required: ['id', 'label'],
        },
        Provider: {
          type: 'object',
          properties: {
            id: {
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
            },
            label: { type: 'string' },
            configured: {
              type: 'boolean',
              description: 'Base image baked (usable for create) on this host.',
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
