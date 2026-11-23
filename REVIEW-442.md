# Review of PR #442 (llm-accounts Phase 4: fan-out per account)

Reviewed: `origin/feat/llm-accounts-p4` @ 06718191 against `origin/nightly`. I read the code only. I ran no tests (CI was still pending) and no live commands.

## Verdict

**I found no BLOCKING issues and no REGRESSIONS.** The five findings below are all LATER.

## Hardest checks: results

1. **A refresh on account X reaches only account X.**
   - Relay (`packages/relay/src/credentials-fanout.ts:164-210`):
     - The account comes from the registration, then `state.json` (`server.ts:554-556`).
     - A named account is accepted only when the store holds it as a `login`.
     - The write goes to `credentials/<agent>/<X>.json` and to custody `agents/<a>/accounts/<X>/<file>`.
     - Debounce is per `(agent, X)`, and the spawn carries `--account X`.
     - Nothing writes the legacy backup, the host tool file or the shared volume.
   - Propagate (`apps/cli/src/commands/credentials.ts:64-92`):
     - It reads X's secret.
     - `planPropagateTargets` (`packages/sandbox-core/src/sync/agent-propagate.ts:312-317`) keeps only boxes whose record names X for the agent. The account filter runs before the borrower branch, so a model-auth borrower on X is included and one on default is not.
     - Docker X boxes resolve to `accountConfigVolume`, which docker create records in `agentConfigVolumes` (`packages/sandbox-docker/src/create.ts:736,798-805`). The shared volume is never a target.
   - Reconcile: `accountReconcilePlan` (`packages/sandbox-cloud/src/sync/agent-credentials.ts:812-840`) gives X its own secret and skips pasted kinds and unknown rows. It never falls back to the default backup.
   - Custody seed (`apps/hub/lib/hub-worker.ts:133-181`) writes only `credentials/<agent>/<id>.json`.
   - **The default direction holds too.** A default refresh is filtered to boxes with no record (`?? DEFAULT_ACCOUNT_ID`), and named boxes reconcile against their own secret.
2. **No named accounts (every existing user).** The behaviour is identical to nightly:
   - Same backup path; `accountCustodyPath(a, 'default', f)` gives `agents/<a>/<f>`.
   - Same propagate argv (no `--account`).
   - The target set is the same as nightly's `namedAccounts(...) !== undefined → skip`.
   - Reconcile gets `backups: {}`.
   - `collectAgentCredentialUploads` skips `default` rows. `readAccounts` does not throw on a missing or corrupt file.
   - The custody seed's account pass lists an empty prefix inside a try. The default loop is unchanged.
   - There is no rename and no migration.
3. **Old images and old records.**
   - ctl is unchanged, and a record without `accounts` routes as default.
   - The relay fails closed in three cases: `state.json` is unreadable (`UNVERIFIABLE_ACCOUNT`, dropped), `accounts.json` is corrupt (`readAccounts` returns only the defaults, so a named update is dropped as "not in the store"), and the reconcile store can't be read (skip).
   - An older CLI still handles a default fan-out, because `--account` is sent only for a named account.
4. **Remote control box and multi-PC.**
   - The control box has no `accounts.json` rows (Phase 5), so its relay drops named updates and its reconcile skips named agents.
   - A PC that adopts a named box gets `accounts` through `registration-to-record.ts:147`. Without the row it fails closed in the relay, propagate and reconcile.
   - The new custody paths have 5 segments and pass both validators: `packages/relay/src/custody/store.ts` and `apps/hub/app/(dashboard)/api/v1/lib/custody-path.ts`.

## Findings

### 1. LATER: `accounts rm` followed by re-adding the same id while boxes still record it
- **Where:** `apps/cli/src/commands/accounts.ts:73-110`, `packages/relay/src/credentials-fanout.ts:178-188`.
- **Scenario:**
  1. Cloud box `b1` runs on `claude/work`.
  2. The user runs `agentbox accounts rm claude/work -y`. This succeeds; nothing checks for boxes that record the account.
  3. The user runs `agentbox claude login --account work` with a different subscription.
  4. `b1` refreshes. The relay now accepts the update, because a `work` login row exists and `b1`'s `expiresAt` is newer. The old identity overwrites the new secret and fans out to every new `work` box.
  5. A resume reconcile can also push the new identity into `b1`.
- **Why it is new:** on nightly the update was dropped. Phase 4 makes the stale box a live writer. It needs a deliberate rm and re-add with boxes still running, so it is not blocking.
- **Fix:** `accounts rm` refuses while any box in `state.json` or a registration records `(agent, id)`. This is the Phase 1 backlog item that was never done.

### 2. LATER: the planner falls back to the shared default volume for a named-account docker box
- **Where:** `packages/sandbox-core/src/sync/agent-propagate.ts:331`: `isolatedVolumeOf(box, agent) ?? sharedVolume`.
- **Scenario:** if a docker box's record names account X but has no `agentConfigVolumes[agent]`, a fan-out for X writes X's login into `agentbox-<agent>-config`, the default shared volume. Today's create always records the account volume, so I found no path that reaches this.
- **Fix:** when the box's account is named, skip the box instead of falling back. Alternatively, target `accountConfigVolume(sharedVolume, X)`.

### 3. LATER (already on nightly): a registration store error is treated as the default account, not as unverifiable
- **Where:** `packages/relay/src/server.ts:554-556`: `store.getBox(boxId).catch(() => undefined)`, then `stateBoxAccount`.
- **Scenario:** `store.getBox` throws for a box that is not in `state.json` yet (the cloud-create race #437-5 closes, or a Store-only box). The lookup answers default, so a named login would be written to the default backup and fanned out to default boxes. Nightly has the same lookup, and the store is in-process SQLite, so this is rare.
- **Fix:** map a `getBox` rejection to `UNVERIFIABLE_ACCOUNT`.

### 4. LATER: named custody objects are keyed by account name only, and are pushed with no consumer yet
- **Where:** `apps/cli/src/control-plane/custody-client.ts:307-325`, `apps/cli/src/commands/credentials.ts:209-230`.
- **Scenario:**
  - Account ids are names local to each PC. PC A's `claude/work` and PC B's `claude/work` (a different subscription) both push to `agents/claude/accounts/work/.credentials.json`, and the push is hash-only, so the last pusher wins.
  - The automatic `syncAgentCredentials` now also uploads every pasted API key and setup token to the control box. Nothing there reads them until Phase 5.
  - `accounts rm` never deletes them (already in the backlog).
- **Effect:** harmless today, but Phase 5 must namespace these objects or reconcile them before it consumes them.
- **Fix (Phase 5):** key by owner or device, or carry the identity. Consider not pushing pasted secrets until the hub can use them.

### 5. LATER (cosmetic): the hub System page counts named-account objects as the agent's login
- **Where:** `apps/hub/lib/custody-view.ts:143-153` (`summarizeAgentCredentials` groups by `agents/<agent>/`).
- **Scenario:** a PC with only a named claude account (no default login) pushes to custody. The System page then shows Claude as having a login, but a hub create gets none.
- **Fix:** count only `agents/<a>/<boxRelPath>` as the agent's login, and list accounts separately.

## Checked and dropped (not bugs)
- **Agent ids:** registration and record `accounts` keys are canonical (`resolveBoxAccounts` uses `spec.id`; `parseCredentialsUpdate` accepts only canonical ids), so the `backups` and `skip` lookups line up.
- **Community providers on the old SDK** ignore `req.accounts`, but they also write the record and registration without `accounts`, so routing stays default end to end.
- **The custody seed's `list`** filters by prefix before it reads any entry. In-flight `.tmp` files are skipped by the segment check.
- **`pushItems` never prunes** remote entries, so a PC with no named accounts cannot delete another PC's account objects.
- **The relay and the CLI ship together.** A stale-hub mismatch would only fail a named fan-out loudly; the default fan-out keeps working.
