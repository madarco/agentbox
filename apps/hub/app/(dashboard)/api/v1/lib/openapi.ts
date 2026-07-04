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
    paths: {
      '/health': {
        get: {
          summary: 'Liveness + API version',
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
          summary: 'Create a box (async — returns a job id). agent "none" just creates the box without starting an agent (prompt ignored). provider defaults to docker; a cloud provider must be configured on the host (see GET /providers).',
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
          summary: 'Lifecycle action (pause | resume | stop | destroy)',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'action', in: 'path', required: true, schema: { type: 'string', enum: ['pause', 'resume', 'stop', 'destroy'] } },
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
          summary: "Live git summary of the box's worktree (current branch, dirty, ahead/behind)",
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
          summary: 'Git op on the box branch. checkout {branch}; branch {name, from?} (create+switch a new agentbox/* branch); pull {remote?, ffOnly?}; push {remote?, force?}; push-host {as?, force?} (land in the host repo only, publishes nothing).',
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
          summary: "List the box project's branches (local + remote) and its current HEAD, for the box git-panel branch picker",
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
          summary: "The box's agentbox.yaml service/task/port status (live, or the persisted snapshot when the box isn't running)",
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
          summary: 'Restart one service (body {name}) or every service (empty body)',
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
      '/projects': {
        get: {
          summary: 'List registered projects',
          responses: {
            '200': { description: 'Projects', content: { 'application/json': { schema: { type: 'object', properties: { projects: { type: 'array', items: { $ref: '#/components/schemas/Project' } } }, required: ['projects'] } } } },
            '401': errorResponse,
          },
        },
        post: {
          summary: 'Register a folder (absolute path) as a project',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } } },
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
          summary: 'Unregister an empty project (folder/files on disk are untouched)',
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
          summary: "List a project's branches (local + remote) and its current HEAD, for the create-box base-branch picker",
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
          summary: 'List sandbox providers and whether each is configured (baked) on this host',
          responses: {
            '200': { description: 'Providers', content: { 'application/json': { schema: { type: 'object', properties: { providers: { type: 'array', items: { $ref: '#/components/schemas/Provider' } } }, required: ['providers'] } } } },
            '401': errorResponse,
          },
        },
      },
      '/approvals': {
        get: {
          summary: 'List pending host-action approvals',
          responses: {
            '200': { description: 'Approvals', content: { 'application/json': { schema: { type: 'object', properties: { approvals: { type: 'array', items: { $ref: '#/components/schemas/Approval' } } }, required: ['approvals'] } } } },
            '401': errorResponse,
          },
        },
      },
      '/approvals/{id}/answer': {
        post: {
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
            provider: { type: 'string', enum: ['docker', 'daytona', 'hetzner', 'vercel', 'e2b'], default: 'docker' },
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
            id: { type: 'string', enum: ['docker', 'daytona', 'hetzner', 'vercel', 'e2b'] },
            label: { type: 'string' },
            configured: { type: 'boolean' },
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
