/**
 * `agentbox codex` — built here, described in the package.
 *
 * The DESCRIPTOR (`codexCliSpec`) lives in `@agentbox/agent-codex/cli`: it is
 * Codex's own wording and its runtime bindings. The commander tree is built
 * here because `buildAgentCommand`'s closure is the whole create/attach
 * pipeline, which has no business moving into an agent package.
 *
 * This file is what remains of `apps/cli/src/agents/codex/` — three lines and a
 * literal import, which is roughly what an agent should cost the app.
 */
import { codexCliSpec } from '@agentbox/agent-codex/cli';
import { buildAgentCommand } from '../command/factory.js';

const { command, attachWrapped } = buildAgentCommand(codexCliSpec);

export const codexCommand = command;
export const attachCodexWrapped = attachWrapped;
