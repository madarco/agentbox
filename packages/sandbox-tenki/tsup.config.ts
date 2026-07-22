import { defineConfig } from 'tsup';

// Three entries:
//   - `src/index.ts` (ESM) — provider surface consumed by apps/cli.
//   - `src/cli.ts`   (ESM) — `agentbox tenki login` subcommand.
//   - `src/attach-helper.ts` (CJS bundle) — standalone Node process spawned by
//     `buildTenkiAttach` to bridge the host PTY -> an in-box SSH channel
//     (`session.ssh()`). CJS because it's invoked via `node <path>` (no
//     package-level type:module hint reaches a standalone .js); bundling lets
//     us ship one file.
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm'],
    target: 'node20',
    clean: true,
    dts: true,
    sourcemap: true,
    // commander + @clack/prompts are external (apps/cli bundles them at the
    // root). The `@tenkicloud/sandbox` SDK is external too — it pulls in
    // ConnectRPC + protobuf + `ws`, which we let resolve via the host's normal
    // module graph rather than inlining into our bundle.
    external: ['commander', '@clack/prompts', '@tenkicloud/sandbox'],
  },
  {
    entry: { 'attach-helper': 'src/attach-helper.ts' },
    format: ['cjs'],
    target: 'node20',
    // Don't clean — the ESM build above already cleaned dist/.
    clean: false,
    // No d.ts for the standalone helper.
    dts: false,
    sourcemap: true,
    external: ['commander', '@clack/prompts', '@tenkicloud/sandbox'],
  },
]);
