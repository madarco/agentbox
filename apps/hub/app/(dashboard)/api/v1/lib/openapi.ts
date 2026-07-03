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
          summary: 'Create a box (async — returns a job id)',
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
            provider: { type: 'string' },
            createdAt: { type: 'number' },
          },
          required: ['id', 'name'],
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
            agent: { type: 'string', enum: ['claude', 'codex', 'opencode'] },
            name: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['projectId', 'agent'],
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
