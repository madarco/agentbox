# Agent history — backlog

Live list of open items while the phases in
[agent-history-plan.md](./agent-history-plan.md) are implemented. Newest at the
bottom of each section.

## Deferred from Phase 1

- **codex capture (Phase 3).** codex's seeded SessionStart/Stop hooks still run
  backgrounded with no `--capture-session`; making them synchronous with capture
  belongs with codex's `history` block and parser.
