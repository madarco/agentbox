import type { MemoryOrigin } from '../history/types.js';

/** A human approval the MCP server asks for (a `memory_propose`). */
export interface McpApprovalRequest {
  /** The question, one line. */
  message: string;
  /** A second line of context. */
  detail?: string;
  /** Longer text a client may show (the proposed content, truncated). */
  summary?: string;
}

/**
 * What a box's MCP caller may see and do, built by the relay from the box's
 * registration (docs/agent-history-plan.md, Phase 6). `repoKey` null = the
 * box's repo is unknown, so it sees no sessions and no memory.
 */
export interface McpBoxScope {
  kind: 'box';
  boxId: string;
  boxName: string;
  repoKey: string | null;
  /** Stamped on a memory version the box's proposal creates. */
  origin: MemoryOrigin;
  /**
   * Ask the box's approvals (the relay's prompt mailbox). Resolves when a
   * human answers, or with false at the TTL; callers do not await it.
   */
  approve(req: McpApprovalRequest): Promise<boolean>;
  /** Redact proposed bytes with the host's secret values, as `memory.put` does. */
  redact(bytes: Uint8Array): Promise<Uint8Array>;
}

/** The hub's MCP server, called by the relay with one JSON-RPC message. */
export type McpBoxHandler = (scope: McpBoxScope, message: unknown) => Promise<unknown>;
