export {
  AGENTBOX_MCP_ARGS,
  AGENTBOX_MCP_COMMAND,
  AGENTBOX_MCP_SERVER_NAME,
  applyMcpRegistration,
  mcpJsonEntry,
  parseAgentMcpSpec,
  type McpRegistrationResult,
} from './registration.js';

/**
 * The relay RPC a box's `agentbox-ctl mcp` sends each JSON-RPC message over:
 * `{message}` in, `{message}` out (`null` for a notification). Routed like
 * `history.*` on docker `/rpc` and the cloud executor.
 */
export const MCP_RPC_METHOD = 'mcp.message';

export type { McpApprovalRequest, McpBoxHandler, McpBoxScope } from './types.js';
