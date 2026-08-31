/**
 * The demo agent's CLI surface — the proof that an agent is a package.
 *
 * When this existed only as a spec row, `apps/cli/test/_agents-in-cli.ts`
 * filtered it out of every table assertion, because the CLI's module and
 * command tables had no arm for it. With this entry point they do, that filter
 * is gone, and "adding an agent costs its own package plus one literal-import
 * arm" is a test result rather than a claim.
 */
export { exampleCliSpec } from './cli-spec.js';
export { agentModule } from './module.js';
export { exampleRuntime, ExampleSessionError } from './runtime.js';
export { EXAMPLE_LOGIN_SPEC } from './login.js';
