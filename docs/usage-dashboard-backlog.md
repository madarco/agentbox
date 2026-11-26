# Usage dashboard — backlog

Open items found while building the phases of
[`usage-dashboard-plan.md`](./usage-dashboard-plan.md). Newest phase first.

## From Phase 1 (activity ledger)

- **Resumes that bypass the hub routes are not recorded.** The ledger has
  `box.paused` from the hub's pause route, docker autopause and the cloud
  keepalive's idle pause. A box woken any other way gets no `box.resumed`: an
  e2b sandbox auto-resuming on inbound traffic, or a paused docker box unpaused
  by something other than `POST /boxes/{id}/resume`. A `start` on a paused box
  resumes it but is recorded as `box.started`. Box-hours in Phase 2 should treat
  `box.started` after `box.paused` as a resume, and read any running/paused
  state change from the box status loop as a fallback.
- **The timeline and the ledger wrap the same box routes separately.** Each
  reads the box record before a destroy or push, and each measures the push
  (`push-measure.ts`). Locally that is cheap (a state file read, two `git`
  runs). On a control box with no checkout, the box-side stat's exec round
  trips run twice per push. The fix is one wrapper that reads and measures
  once and hands the result to both writers.
- **A box-side push stat depends on the box's tracking ref.** A hub-route push
  on a box with no host checkout reads `refs/remotes/origin/<branch>` in the
  box before pushing and measures from it. If the box's push path does not
  update that ref, the next push still counts from the older tip. That
  overcounts commits, though by less than the old whole-branch measure.
  Verify on a control box (Phase 4's live check).
- **`hostOnly` pushes are counted rows.** A `push --host-only` landing is
  recorded with `hostOnly: true`. If the same commits are pushed later, Phase 2
  must not count them twice. Count published pushes for "shipped", and
  host-only landings only when nothing published follows.
- **Backfilled rows carry less.** A workspace timeline has no provider or
  account, and its repo is the workspace project's (or the PR's). Destroyed
  boxes' rows can't be enriched afterwards.
- **A Store-only box (a PC's box on a control box) has no account.** The context
  comes from its registration: name, origin, and `backend` as the provider.
- **The PR sweep covers GitHub repos only, for 30 days.** It polls
  `gh pr list --repo` for every repo with a box branch in the ledger whose PR is
  not merged or closed yet. A box branch older than 30 days drops out of it.
- **The ledger is never trimmed.** It is one small row per event (a busy month is
  a few thousand rows). If it grows, add a retention sweep like history's.
- **A laptop with a control box configured writes its own boxes to its own
  ledger.** The control box's boxes are in the control box's ledger. Merging the
  two is Phase 4's job (the laptop's stats fetch the control box's and merge).
- **`box.failed` carries no reason.** Deliberately: the ledger holds no free text
  (the share snapshot must not leak any). The create job's log has it.
