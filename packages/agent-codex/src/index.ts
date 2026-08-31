/**
 * Codex as a package.
 *
 * Today this re-exports the spec only — the behavior (CLI command, docker sync,
 * login, teleport, pull) moves in over the following phases. Consumers that
 * need just the data should import `@agentbox/agent-codex/spec` instead, which is
 * the entry with no dependencies.
 */

export { codexSpec } from './spec.js';
