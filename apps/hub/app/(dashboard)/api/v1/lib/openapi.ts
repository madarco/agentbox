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
      { name: 'Hosts', description: 'Remote-docker host aliases (name -> SSH connection).' },
      { name: 'Approvals', description: 'Pending host-action approvals.' },
      { name: 'Jobs', description: 'Async create/bake job status and log streams.' },
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
          summary: 'List boxes',
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
            'Async — returns a job id. agent "none" just creates the box without starting an agent (prompt ignored). provider defaults to docker; a cloud provider must be configured on the host (see GET /providers).',
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
            'One of start | pause | resume | stop | destroy | screen. start brings a stopped box back up (resumes if paused, no-op if already running); it does not restart the agent session — that happens on the next attach. screen is the open-VNC prep step: it points the in-box browser at the box’s web app so the VNC desktop shows the app instead of a blank X screen — call it right before opening the box’s vncUrl.',
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
                    claudeInstall: { type: 'string', enum: ['native', 'npm'] },
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
                  properties: { answer: { type: 'string', enum: ['y', 'n'] } },
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
      '/custody': {
        get: {
          tags: ['Custody'],
          summary: 'List the custody manifest (metadata only)',
          description:
            'What the control box holds so a box created from either side is usable from both: agent credentials, project seeds, provider bake records, and per-box SSH keys. Returns paths, hashes, sizes and mtimes ONLY — value bytes never leave the box (same contract as `agentbox hub custody list`). `enabled` is false on a hub with no custody (e.g. a localhost hub). Optional `?prefix=` scopes the listing to a custody scope (`agents` | `projects` | `prepared` | `boxes`) or a `scope/subject`.',
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
        Custody: {
          type: 'object',
          properties: {
            enabled: {
              type: 'boolean',
              description: 'false when this hub holds no custody (no admin token)',
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
            claudeSessionTitle: { type: 'string' },
            codexSessionTitle: { type: 'string' },
            opencodeSessionTitle: { type: 'string' },
            claudeActivity: {
              type: 'string',
              description:
                'working | idle | waiting | end-plan | question | compacting | error | unknown',
            },
            codexActivity: { type: 'string' },
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
          },
          required: ['id', 'status'],
        },
        CreateBox: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            agent: { type: 'string', enum: ['claude', 'codex', 'opencode', 'none'] },
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
