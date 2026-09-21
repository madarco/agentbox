# AgentBox test plan

> Part of the AgentBox docs. Start at [CLAUDE.md](../CLAUDE.md). Anything hub- or control-box-shaped is covered separately in [`hub-testing.md`](./hub-testing.md).

The regression check before a release is **`pnpm e2e`**: 8 real-life scenarios run against the packed CLI on every provider and on a Linux host. The design, the isolation rules and the targets are in [`release-e2e-plan.md`](./release-e2e-plan.md); the code is in [`e2e/`](../e2e). This page is the short version plus the map from the old per-command checklist IDs to where each check lives now. The IDs are still cited in other docs and in step `covers:` lists, and each run's `summary.json` records them.

## Running it

```bash
pnpm e2e --targets all                         # the release run: every provider + the Linux VM
pnpm e2e --targets docker@mac --scenarios s2   # one scenario while iterating
pnpm e2e --no-build --reuse-bake ...           # skip the pack and the bakes on a re-run
pnpm e2e --help
```

The report is `e2e/runs/<sha>-<run>/report.html`. A stable release needs a green run of the released commit (the `/release-notes` gate checks for it).

Prerequisites: Docker running; `gh` logged in with access to `madarco/agentbox-test-repo`; cloud logins in `~/.agentbox/secrets.env`; for `docker@linux` and `remote-docker`, the Hetzner test VM (`scripts/hub-test-vm.sh up && creds`). The run never touches your own `~/.agentbox`, hub or boxes; see "Isolation" in the plan for the one thing it can't isolate (never run `agentbox prune` during a run).

## The scenarios

| | Scenario | Where it runs |
|---|---|---|
| S1 | Fresh install (packed CLI + the real `agentbox install` wizard) and a forced bake | every target; the wizard on docker@mac |
| S2 | Agent round trip: dirty repo → `-i` turn → relay push → PR merged (claude, codex, opencode) | every target (codex/opencode on docker + one rotating cloud) |
| S3 | Pause/unpause, stop/start, checkpoint → new box, set-default, destroy leaves nothing | every target |
| S4 | `examples/express-ready`: `wait`, `status`, `logs`, web + VNC URLs, `cp`, `download`, restart policy, `top` | every target |
| S5 | Host tools: refuse → request → approve via `/api/v1` → works; credential deny list; no host secret in the box | every target |
| S6 | openclaw: ready + URL, real gateway token, run-env, backup → destroy → restore with the same identity | docker, hetzner, remote-docker |
| S7 | Workspace over two projects, a task's box, its merged PR on the timeline, a hub-run manager answering a message | docker@mac |
| S8 | Dashboard (PTY), `shell`, hub web UI (screenshot), menu-bar app (AX driver), judged by the AI judge | docker@mac |

## Where each checklist ID lives

**In a scenario** (the step names the ID in its `covers:`):

| IDs | Scenario |
|---|---|
| BOOT-001, BOOT-002 | S1 |
| PREP-001..006 | S1 |
| RELAY-004, RELAY-005, RELAY-006 | S1 |
| DAYTONA-001/002, HET-001/002, provider `login --status` | S1 |
| CLAUDE-001, CODEX-001, OPENCODE-001, ATTACH-001, CLAUDE-005 (config volumes are isolated per box in every run) | S2 |
| CREATE-001..003, CREATE-010, CREATE-013, CREATE-015, CTL-002 | S2 |
| RELAY-008, LS-001..003 | S2 |
| PAUSE-001..003, START-001/002, CKPT-001..003, CKPT-005, CKPT-006, CREATE-004, DESTROY-001 | S3 |
| WAIT-001, WAIT-003, STATUS-001, LOGS-001, URL-001/002, SCREEN-001/002, CP-001/002, DL-001, CTL-006, CTL-010, TOP-001 | S4 |
| TOOLS-001..005, TOOLS-007, TOOLS-009 | S5 |
| CLAW-001, CLAW-002, CLAW-005, CLAW-006 | S6 |
| DASH-001..003, SHELL-001 | S8 |
| XPROV-001 (several providers against one hub) | the full `--targets all` run |

**In unit tests** (pure logic; no box needed): CFG-001..007 (`packages/config/test`), CTL-003..005, CTL-011, CTL-014..016 (`packages/ctl/test`), CREATE-016 (carry resolver), RELAY-007, REL-EXT-001..005 (`packages/relay/test`), BOOT-003/004 (`pnpm build`, `pnpm lint`, `pnpm test`).

**Manual** (need a GUI editor, a FUSE mount, a login flow or a host-level change): CODE-001/002, OPEN-001/002, CLAUDE-004 (`claude login`), DAYTONA-003, HET-003/004, PREP-007, UPDATE-001/002, DASH-004..012, DASH-EXT-001..004. Anything hub- or control-box-shaped (REL-EXT-006/007): [`hub-testing.md`](./hub-testing.md).

**Not yet in a scenario** (candidates, tracked in [`release-e2e-backlog.md`](./release-e2e-backlog.md)): CLAUDE-002/003, CODEX-002, CKPT-004, CKPT-007..009, CP-003, CREATE-005..009, CREATE-011/012, CREATE-014, DESTROY-002/003, DL-002..005, LOGS-002/003, CLAW-003/004, RELAY-001..003, RELAY-009/010, SCREEN-003, SHELL-002..005, STATUS-002, TOOLS-006, TOOLS-008, TOP-002, URL-003/004, WAIT-002, CTL-001, CTL-007..009, CTL-012/013, XPROV-002/003.

**Deliberately excluded**: PRUNE-001..003. `prune` deletes every sandbox the running fleet doesn't track, so on an account shared with real boxes it is unsafe to exercise; the sweep only uses its `dryRun` listing.

## Known gaps

Tracked in the backlog docs; not regressions until the backlog item closes.

| Gap | Backlog |
| --- | --- |
| Cloud `download env / config / claude / codex / opencode` not routed (was DL-006) | `daytona-backlog.md`, `hertzner_backlog.md` |
| `agentbox prune --provider hetzner` not wired (was HET-005, PRUNE-004) | `hertzner_backlog.md` |
| `checkpoint create --pause` on hetzner | `hertzner_backlog.md` |
| True zero-cost pause on hetzner (snapshot + respawn) | `hertzner_backlog.md` |
| Daytona workspace-state checkpoint (`_experimental_createSnapshot` blocker) | `daytona-backlog.md` |

## Maintenance

A new user-visible behavior gets a step in the scenario whose flow it belongs to, not a new scenario; keep the list at about 8. Put the ID it replaces (or a new one) in the step's `covers:` and move it into the table above. A check that needs no box belongs in a unit test.
