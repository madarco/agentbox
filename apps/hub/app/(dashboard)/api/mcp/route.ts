// POST /api/mcp — the hub's MCP server over streamable HTTP
// (docs/agent-history-plan.md, Phase 6). Gated like /api/v1 (proxy.ts: Bearer
// hub token or the hub cookie, JSON 401). Stateless: every reply is one JSON
// body, never an SSE stream, and there is no session id. Boxes do not come
// here; they reach the same server through their relay (`agentbox-ctl mcp`).
import { skillBytesReadAllowed } from '../v1/skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 1024 * 1024;

const rpcError = (status: number, code: number, message: string): Response =>
  Response.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status });

export async function POST(req: Request): Promise<Response> {
  const mcp = globalThis.__AGENTBOX_HUB_MCP;
  if (!mcp) return rpcError(503, -32603, 'the MCP server is not running on this hub');
  // DNS-rebinding guard (MCP transport spec): a browser page on another origin
  // must not drive this endpoint with the hub cookie.
  const origin = req.headers.get('origin');
  if (origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === new URL(req.url).host;
    } catch {
      sameHost = false;
    }
    if (!sameHost) return rpcError(403, -32600, 'cross-origin request refused');
  }
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return rpcError(413, -32600, 'body too large');
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, 'parse error');
  }
  const reply = await mcp.handle(message, { skillBytes: skillBytesReadAllowed(req) });
  if (reply === null || reply === undefined) return new Response(null, { status: 202 });
  return Response.json(reply);
}

// No server-initiated stream and no session to end.
export function GET(): Response {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}

export function DELETE(): Response {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}
