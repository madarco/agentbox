# Task: LLM accounts — Phase 1 (account model + store)

Read `docs/llm-accounts-plan.md` end to end, especially "Phase 0 results" and "Changes to Phases
1–8" (measured facts that change the design: per-account docker config volume + shared projects
volume; a claude refresh revokes every other holder; setup-token for accounts shared by many boxes;
an API-key account needs its own volume pre-seeded with `customApiKeyResponses.approved`). Then
CLAUDE.md, `docs/agents.md`, `docs/agent-settings-plan.md`, `docs/model-auth-sources-plan.md`.

Implement **Phase 1 only**: the account model + store in `@agentbox/core` / `sandbox-core`: types,
`accounts.json`, per-account secret paths, the `default` migration (existing single-slot logins
become account `default` with no user step and nothing breaks), `accountKinds` on registry rows.
Pure and unit-tested. Update the plan where reality differs, start `docs/llm-accounts-backlog.md`.
Watch the provider SDK rule in CLAUDE.md: if a type re-exported by `@madarco/agentbox-provider-sdk`
changes, say so in the PR (the coordinator handles the republish).

Process: plan first; branch `git fetch origin && git checkout -b feat/llm-accounts-p1 origin/nightly`;
code; `/code-review medium`, fix; gates (build, typecheck, lint, touched tests, prettier on changed
files); PR `--base nightly` (design, migration story, what Phase 2 builds on, review, gates). Do not
merge. Work sequentially, no parallel subagents.
