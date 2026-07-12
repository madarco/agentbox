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
      { name: 'Providers', description: 'Sandbox providers: status, credentials, base-image bake.' },
      { name: 'Approvals', description: 'Pending host-action approvals.' },
      { name: 'Jobs', description: 'Async create/bake job status and log streams.' },
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
                  schema: { type: 'object', properties: { boxes: { type: 'array', items: { $ref: '#/components/schemas/Box' } } }, required: ['boxes'] },
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
              content: { 'application/json': { schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] } } },
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
            '200': { description: 'Box', content: { 'application/json': { schema: { $ref: '#/components/schemas/Box' } } } },
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
            { name: 'action', in: 'path', required: true, schema: { type: 'string', enum: ['start', 'pause', 'resume', 'stop', 'destroy', 'screen'] } },
          ],
          responses: {
            '200': { description: 'Done', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] } } } },
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
            '200': { description: 'Git info', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitInfo' } } } },
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
            { name: 'op', in: 'path', required: true, schema: { type: 'string', enum: ['checkout', 'branch', 'pull', 'push', 'push-host'] } },
          ],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/GitOpBody' } } },
          },
          responses: {
            '200': { description: 'Done (git stdout/stderr)', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitOpResult' } } } },
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
          description: 'Local + remote branches and the current HEAD, for the box git-panel branch picker.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Branches', content: { 'application/json': { schema: { $ref: '#/components/schemas/BranchList' } } } },
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
          description: "From the box's agentbox.yaml — live, or the persisted snapshot when the box isn't running.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Services', content: { 'application/json': { schema: { $ref: '#/components/schemas/Services' } } } },
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
            content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
          },
          responses: {
            '200': { description: 'Restarted', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] } } } },
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
                  properties: { app: { type: 'string', enum: ['codex', 'herdr', 'cmux', 'vscode', 'iterm2'] } },
                  required: ['app'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'Launched', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] } } } },
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
            '200': { description: 'Projects', content: { 'application/json': { schema: { type: 'object', properties: { projects: { type: 'array', items: { $ref: '#/components/schemas/Project' } } }, required: ['projects'] } } } },
            '401': errorResponse,
          },
        },
        post: {
          tags: ['Projects'],
          summary: 'Register a folder as a project',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the folder.' } }, required: ['path'] } } } },
          responses: {
            '200': { description: 'Registered', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] } } } },
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
            '200': { description: 'Removed', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] } } } },
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
          description: 'Local + remote branches and the current HEAD, for the create-box base-branch picker.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Branches', content: { 'application/json': { schema: { $ref: '#/components/schemas/BranchList' } } } },
            '400': errorResponse,
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
      '/providers': {
        get: {
          tags: ['Providers'],
          summary: 'List sandbox providers',
          description: 'With credential + baked status on this host.',
          responses: {
            '200': { description: 'Providers', content: { 'application/json': { schema: { type: 'object', properties: { providers: { type: 'array', items: { $ref: '#/components/schemas/Provider' } } }, required: ['providers'] } } } },
            '401': errorResponse,
          },
        },
      },
      '/providers/{id}/credentials': {
        post: {
          tags: ['Providers'],
          summary: "Set a provider's credentials",
          description: 'API keys/tokens, validated then saved to secrets.env. Never echoes secret values.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', enum: ['docker', 'daytona', 'hetzner', 'vercel', 'e2b', 'digitalocean', 'aws'] } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: { type: 'string' }, description: 'Provider-specific fields, e.g. { apiKey } (e2b), { token } (hetzner), { apiKey } or { jwtToken, organizationId } (daytona), { token, teamId?, projectId? } (vercel).' } } } },
          responses: {
            '200': { description: 'Saved', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] } } } },
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
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', enum: ['docker', 'daytona', 'hetzner', 'vercel', 'e2b', 'digitalocean', 'aws'] } }],
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { force: { type: 'boolean' }, claudeInstall: { type: 'string', enum: ['native', 'npm'] } } } } } },
          responses: {
            '202': { description: 'Bake enqueued', content: { 'application/json': { schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] } } } },
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
            '200': { description: 'Approvals', content: { 'application/json': { schema: { type: 'object', properties: { approvals: { type: 'array', items: { $ref: '#/components/schemas/Approval' } } }, required: ['approvals'] } } } },
            '401': errorResponse,
          },
        },
      },
      '/approvals/{id}/answer': {
        post: {
          tags: ['Approvals'],
          summary: 'Answer a pending approval',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { answer: { type: 'string', enum: ['y', 'n'] } }, required: ['answer'] } } } },
          responses: {
            '200': { description: 'Resolved', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] } } } },
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
            '200': { description: 'Job', content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } } },
            '401': errorResponse,
            '404': errorResponse,
          },
        },
      },
      '/jobs/{id}/logs': {
        get: {
          tags: ['Jobs'],
          summary: 'Stream a create job log (SSE)',
          description: 'text/event-stream. Emits `open`, then `log` events per line, then a terminal `end` event with the final status.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'SSE stream', content: { 'text/event-stream': {} } },
            '401': errorResponse,
            '404': errorResponse,
            '503': errorResponse,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'The hub token (Authorization: Bearer <token>).' },
      },
      schemas: {
        Health: {
          type: 'object',
          properties: { ok: { const: true }, apiVersion: { type: 'string' }, profile: { type: 'string' } },
          required: ['ok', 'apiVersion'],
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
            displayName: { type: ['string', 'null'], description: 'Cosmetic user-set label (rename); null when unset' },
            webUrl: { type: ['string', 'null'], description: 'Host-openable web-service URL; null when absent/unreachable (e.g. paused)' },
            vncUrl: { type: ['string', 'null'], description: 'Host-openable VNC desktop URL; null when absent/unreachable' },
            state: {
              type: 'string',
              enum: ['running', 'paused', 'stopped', 'missing'],
              description:
                'Raw provider runtime state (host topology only). Absent on synthetic creating/error rows — presence distinguishes a real box whose agent errored from a failed create job.',
            },
            name: { type: 'string' },
            provider: { type: 'string', description: "Raw provider id ('docker', 'daytona', …; plugin ids possible)" },
            projectRoot: { type: 'string', description: 'Absolute host path of the project. Host topology only — never emitted by the hosted plane' },
            projectIndex: { type: 'number' },
            vncEnabled: { type: 'boolean' },
            gitWorktrees: {
              type: 'array',
              items: { type: 'object', properties: { kind: { type: 'string' }, branch: { type: 'string' } } },
            },
            claudeSessionTitle: { type: 'string' },
            codexSessionTitle: { type: 'string' },
            opencodeSessionTitle: { type: 'string' },
            claudeActivity: { type: 'string', description: 'working | idle | waiting | end-plan | question | compacting | error | unknown' },
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
            needsSetup: { type: 'boolean', description: 'No agentbox.yaml + no default snapshot — the create form offers the setup wizard' },
            provider: { type: 'string' },
            createdAt: { type: 'number' },
          },
          required: ['id', 'name'],
        },
        BranchList: {
          type: 'object',
          properties: {
            current: { type: 'string', nullable: true, description: 'The repo\'s current HEAD (the default base ref)' },
            branches: { type: 'array', items: { type: 'string' }, description: 'Local + remote-tracking branch names' },
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
            provider: { type: 'string', enum: ['docker', 'daytona', 'hetzner', 'vercel', 'e2b', 'digitalocean', 'aws'], default: 'docker' },
            name: { type: 'string' },
            prompt: { type: 'string' },
            fromBranch: { type: 'string', description: "Base ref the box's per-box branch forks from (branch / tag / SHA); default the project's HEAD" },
            setupWizard: { type: 'boolean', description: 'Seed the agent\'s first turn to generate agentbox.yaml (for projects with none). Inert for agent "none".' },
          },
          required: ['projectId', 'agent'],
        },
        Provider: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: ['docker', 'daytona', 'hetzner', 'vercel', 'e2b', 'digitalocean', 'aws'] },
            label: { type: 'string' },
            configured: { type: 'boolean', description: 'Base image baked (usable for create) on this host.' },
            hasCredentials: { type: 'boolean', description: 'Credentials present (docker: always true). Can be true while not yet configured (baked).' },
            jobId: { type: 'string', description: 'Id of an in-flight bake (prepare) job for this provider, if any.' },
            reason: { type: 'string' },
          },
          required: ['id', 'label', 'configured'],
        },
        GitOpBody: {
          type: 'object',
          description: 'Union of git-op fields; only those for the chosen {op} are read (extras are ignored).',
          properties: {
            branch: { type: 'string', description: 'checkout: branch to switch to' },
            name: { type: 'string', description: 'branch: new branch name (agentbox/ prefix added when missing)' },
            from: { type: 'string', description: "branch: base ref to fork from (default: box's HEAD)" },
            remote: { type: 'string', description: 'push/pull: remote name (default: origin)' },
            force: { type: 'boolean', description: 'push: force the remote push; push-host: overwrite the destination branch' },
            ffOnly: { type: 'boolean', description: 'pull: pass --ff-only to the merge' },
            as: { type: 'string', description: "push-host: destination branch name in the host repo (default: the box's branch)" },
          },
        },
        GitOpResult: {
          type: 'object',
          properties: { ok: { const: true }, stdout: { type: 'string' }, stderr: { type: 'string' } },
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
              items: { type: 'object', properties: { name: { type: 'string' }, state: { type: 'string' } }, required: ['name', 'state'] },
            },
            ports: {
              type: 'array',
              items: { type: 'object', properties: { port: { type: 'number' }, service: { type: ['string', 'null'] } }, required: ['port'] },
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
