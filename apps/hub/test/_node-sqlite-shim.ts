// Test-only stand-in for `node:sqlite`, aliased in by `vitest.config.ts`.
//
// `node:sqlite` is a PREFIX-ONLY builtin: node lists it in `builtinModules` as
// "node:sqlite" and never as "sqlite". Vite 5 strips the `node:` prefix before its
// builtin check, concludes there must be a package called "sqlite", and fails the
// load — so any test that reaches `lib/auth.ts` dies on `Failed to load url
// sqlite`. It is purely a vite limitation: the same import works under Next,
// turbopack, esbuild and plain node.
//
// `createRequire` resolves at runtime, past anything vite can intercept, so this
// hands back the genuine builtin rather than a mock.
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const sqlite = req('node:sqlite') as typeof import('node:sqlite');

export const { DatabaseSync, StatementSync } = sqlite;
export default sqlite;
