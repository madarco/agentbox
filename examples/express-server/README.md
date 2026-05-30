# express-server — wizard test fixture

A deliberately tiny Express server used to exercise the **first-run setup wizard** (`apps/cli/src/wizard.ts`). There is no `agentbox.yaml` checked in — that is the whole point: the wizard should fire on `agentbox create` / `agentbox claude` and ask the agent to generate one.

## Important: run from a copy OUTSIDE this monorepo

`findProjectRoot` (`packages/config/src/paths.ts`) walks **up** from the cwd to the first ancestor that has an `agentbox.yaml`. This fixture lives inside the agentbox repo, and the repo root has its own `agentbox.yaml`. So running `agentbox` *in place* here resolves the project to the monorepo root: the wizard never fires (it sees `hasAgentboxYaml: true` and just proceeds), and the box wrongly inherits the **root config** — its `carry:` block (copies host secrets / Vercel CLI store) and its `tasks:` (a full `pnpm install` + `pnpm build` of agentbox itself).

To actually test the wizard, copy the fixture somewhere with no `agentbox.yaml` ancestor first:

```sh
DEST="$(mktemp -d)/express-server"
cp -R examples/express-server "$DEST"
cd "$DEST"
agentbox claude -n express-wiz   # or: node /ABS/PATH/to/agentbox/apps/cli/dist/index.js claude -n express-wiz
```

(In real use this never bites — a user's own project isn't nested under another project's `agentbox.yaml`. It only matters for this in-repo fixture.)

## What a correctly-generated `agentbox.yaml` looks like

The agent should detect:

- `package.json` with `dependencies.express` and `scripts.dev` → a `pnpm install` (or `npm install`) **task** is needed before the server runs.
- `server.js` reads `process.env.GREETING` and exits non-zero when it's missing → either declare a `service.env.GREETING` value in the yaml, or remind the user to `cp .env.example .env` before starting.
- The server listens on `process.env.PORT ?? 3000` → readiness probe should be `port: 3000` (or whatever PORT is set to).

A plausible result, written to `/workspace/agentbox.yaml`:

```yaml
# yaml-language-server: $schema=https://agent-box.sh/schema/agentbox.schema.json
tasks:
  install:
    command: npm install

services:
  dev:
    command: npm run dev
    needs: [install]
    env:
      GREETING: hello from agentbox
    ready_when:
      port: 3000
      timeout_ms: 60000
    restart: on-failure
```

## Manual smoke test

After `pnpm build`, copy the fixture out of the monorepo (see the caveat above —
running in place inherits the root `agentbox.yaml` and the wizard won't fire):

```sh
CLI="$PWD/apps/cli/dist/index.js"        # absolute path to the built CLI
docker rmi agentbox/box:dev              # force image rebuild so the new guide bakes in
DEST="$(mktemp -d)/express-server"
cp -R examples/express-server "$DEST"
cd "$DEST"
node "$CLI" claude -n express-wiz
```

Expected:
1. Wizard prompt: *"No `agentbox.yaml` found in …/express-server. Want me to launch Claude to generate one for you?"* — answer yes.
2. `~/.claude/skills/agentbox-setup/SKILL.md` is created the first time (`log.success` confirms it).
3. Claude opens with an initial directive to read `/usr/local/share/agentbox/setup-guide.md` and write `/workspace/agentbox.yaml`.
4. Verify in the box: `docker exec agentbox-express-wiz cat /workspace/agentbox.yaml`.

To exercise the `create` switch-to-claude path instead (still from `$DEST`):

```sh
node "$CLI" create -n express-wiz2
```

Answer yes to both prompts (generate / switch). The CLI re-dispatches to `claudeCommand` with the create flags forwarded, and the inner wizard pass slots in the initial prompt.

## Cleanup

```sh
node "$CLI" destroy express-wiz express-wiz2 -y
```
