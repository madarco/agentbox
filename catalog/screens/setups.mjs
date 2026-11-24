/* The environments the screens are taken in: what each one is and the
   commands that start it. An entry in catalog.mjs names one in `setup`.
   Paths are relative to catalog/ unless they start with ../ (the repo) or
   ../../ (a sibling repo). None of them touches the owner's ~/.agentbox or
   the hub on 8787. */

export const SETUPS = {
  "fixture-hub": {
    title: "Fixture hub: the real hub UI on the Acme demo data",
    what: "apps/hub's own production build, served by scripts/fixture-hub.mjs on 127.0.0.1:3126 with a fixture backend (fixtures/acme.mjs) and every /api/v1 route answered from fixtures/api.mjs. No relay, no boxes, no sign-in; HOME is .cache/home.",
    commands: [
      "pnpm --filter @agentbox/hub build   # only when apps/hub changed since the last build (from the repo root)",
      "pnpm fixture-hub                    # http://127.0.0.1:3126, leave it running",
      "pnpm shoot <file> <path>            # in another terminal",
    ],
    notes: [
      "A route a page asks for that has no fixture prints \"unhandled GET ...\" in the fixture hub's log, and shoot warns \"answered 404\". Add it to fixtures/api.mjs.",
      "The hub reads the clock in the browser: shoot pins it to NOW in fixtures/acme.mjs, so \"3m ago\" is the same on every run.",
    ],
  },

  "fixture-tray": {
    title: "Tray app in fixture mode (AgentBoxE2E.app --fixtures)",
    what: "A second tray instance from ../agentbox-tray (own bundle id and process name, so the owner's real tray is never touched), launched with --fixtures: the tray's in-memory FixtureBoxSource, the same Acme story as the hub fixtures, no hub, no shell-outs. Driven through Accessibility by e2e/tray-driver.",
    commands: [
      "cd ../../agentbox-tray && make e2e-app            # builds AgentBoxE2E.app (after a tray change)",
      "cd ../e2e/tray-driver && swift build -c release   # the AX driver, once",
      "pnpm shoot:tray <file> [--press <ax id>]...       # launches the app itself when it is not running",
    ],
    notes: [
      "Opening a menu takes the screen for a moment: shoot:tray waits until the Mac has had 3s without input. Don't use the Mac while it runs.",
      "Captures are `screencapture -l <window id>` of the app's own windows, never a screen region, so nothing else on the screen gets in.",
      "The terminal that runs it needs Screen Recording and Accessibility permission (System Settings → Privacy & Security).",
      "The tray's demo data lives in the tray repo (Sources/AgentBox/Source/FixtureBoxSource.swift), not here. Keep fixtures/acme.mjs in step with it.",
    ],
  },

  "fixture-cli": {
    title: "CLI in a PTY, HOME pointed at the fixture hub",
    what: "apps/cli/dist/index.js run in the repo's PTY harness (`pnpm drive`) with HOME=.cache/cli-home, whose config sets relay.port to 3126: every hub-backed command reads the fixture hub. The rendered screen, colours included, is drawn into a terminal window by scripts/shoot-cli.mjs.",
    commands: [
      "pnpm --filter agentbox build   # from the repo root, when the CLI changed",
      "pnpm fixture-hub               # leave it running",
      "pnpm shoot:cli <file> [options] -- <agentbox args>",
    ],
    notes: [
      "The prompt line (\"~/Projects/commerce ❯ agentbox ...\") is drawn, not typed.",
      "Checks that read the real machine (the system compatibility step of the wizard) show this Mac's result.",
    ],
  },

  "docs-site": {
    title: "Taken for the public docs (apps/web)",
    what: "Real screenshots of real boxes, taken for agent-box.sh/docs and kept in apps/web/public/screenshots. How each was taken, and which are stale, is in apps/web/images.md.",
    commands: ["# see apps/web/images.md, section 1 (the test environment) and its status table"],
  },
};
