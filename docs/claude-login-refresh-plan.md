# Detect expired Claude login during box create → in-card browser re-login

## Context

When a box is created, the host syncs the user's `~/.claude` credentials into the box
(or a shared credential volume). Those credentials can be **expired / dead** (the
refresh token gets blanked after a rejected refresh, or the cloud backup's
`expiresAt` has passed). Today the hub-created path (`POST /api/v1/boxes` → queued
worker) does **no** credential check — only the interactive CLI and the `-i` submit
path fail-fast. So a box can be created that silently sits on `/login` / 401s.

We want: **during create, detect an expired Claude login, and (if so) start a docker
container to re-login via the browser** — surfacing the container's **verbatim** log,
a **clickable** login URL, and a **code input** (the claude.ai OAuth flow needs the
user to paste back an approval code) directly in the create card. On success the login
refreshes and the box create continues automatically. Verbatim log (not
parsed/reformatted) is a hard requirement — claude may key off non-interactive/altered
output, so we mirror the raw pty stream and put the clickable link in a *separate*
banner sourced from a structured `url` field, never by rewriting the log text.

Almost all machinery already exists (see "Reuse map"); this is mostly wiring.

## Reuse map (do not rebuild these)

- **Expiry detection** — `apps/cli/src/lib/queue/assert-creds.ts` `claudeCredStatus(env, isCloud)`
  → `'ok'|'missing'|'expired'` (cloud-gated); `packages/sandbox-docker/src/sync/claude-credentials.ts`
  `volumeClaudeCredentials(volume, image)` → `{present, hasRefreshToken}` (the docker-accurate
  "dead login" probe); `hostClaudeBackupExpired()` in `packages/sandbox-core/src/sync/concerns/credentials.ts`.
- **The docker login flow** — `apps/cli/src/commands/_claude-login-worker.ts` already runs
  `claude auth login` in a throwaway docker container under node-pty, mirrors output **verbatim**
  via `log.raw`, extracts the OAuth URL (`extractOAuthUrl` in `apps/cli/src/lib/claude-login-session.ts`),
  waits for a pasted code, then runs `warmUpClaudeCredentials` + `syncClaudeCredentials`.
  Building blocks: `buildClaudeLoginRunArgv` / `warmUpClaudeCredentials` in
  `packages/sandbox-docker/src/sync/agents/claude.ts`; `deliverLoginCode` / `LoginState`
  (`{phase:'starting'|'awaiting-code'|'exchanging'|'done'|'error', url?, error?}`) in `claude.ts` /
  `claude-login-session.ts`.
- **Create worker** — `apps/cli/src/commands/_run-queued-job.ts`: `runDockerJob` (`createBox` @~168)
  and `runCloudJob` (`provider.create` @~350), both with `onLog: (line) => log.write(line)`;
  `openCommandLog` gives `log.write` (annotated) + `log.raw` (verbatim).
- **Queue manifest** — `packages/relay/src/queue.ts` `QueueJob` (no schema validation; `writeJob`
  just stringifies — adding a field is safe). `queueLogPath(id)` layout precedent.
- **Hub job API** — `getJob` (`apps/hub/lib/hub-backend.ts:715`) → `{status, logPath, boxId?}`;
  `JobView` (`apps/hub/lib/boxes/backend-types.ts:109`); SSE `streamJobLog`
  (`apps/hub/lib/job-log-stream.ts`, events `open`/`log`/`end`, 500ms `getJob` poll);
  v1 routes under `apps/hub/app/(dashboard)/api/v1/jobs/[id]/`.
- **UIs** — hub web: `job-log-stream.tsx` (EventSource, renders `lines.join('\n')` in a `<pre>`) +
  `create-box-modal.tsx` (`JobStatusBadge`). Tray: `CreateBoxPanel.swift` progress card +
  `JobLogStreamClient.swift` (SSE) + `HubClient.swift`.

## Design: one structured `login` sub-state, carried both directions

Add an optional `login` object to the `QueueJob` manifest — the single source of truth,
read/written by both the worker and the hub (same host, shared filesystem, no new IPC):

```
login?: {
  required: boolean
  phase: 'starting' | 'awaiting-code' | 'exchanging' | 'done' | 'error'
  url?: string          // worker → UI (clickable)
  error?: string        // worker → UI
  code?: string         // UI → worker (the pasted approval code; consumed + cleared)
}
```

The worker writes `phase/url/error`; the hub's code endpoint writes `code`; the worker
polls for `code`, delivers it to claude, clears it. The verbatim login transcript rides
the **existing** create-log SSE (no second stream). The clickable URL comes from
`login.url` (a banner), so the `<pre>`/log text stays byte-for-byte verbatim.

---

## Phase 1 — Shared worker + hub API (the core) — ✅ DONE + verified (2026-07-04)

Landed: `apps/cli/src/lib/claude-login-run.ts` (extracted `runClaudeLogin`),
`_claude-login-worker.ts` (refactored onto it), `_run-queued-job.ts`
(`needsClaudeLogin` / `ensureClaudeLoginFresh` in both docker + cloud paths),
`QueueJob.login` (+ `QueueJobLogin`) in `packages/relay/src/queue.ts`, hub
`getJob`/`submitLoginCode` + `JobLoginView`, the `login` SSE event in
`job-log-stream.ts`, `login` on `GET /api/v1/jobs/[id]`, and
`POST /api/v1/jobs/[id]/login-code`. Verified live: healthy create = no-op;
forced-expiry daytona create → worker started the login container and reached
`awaiting-code` with a real OAuth URL in ~3s (before any cloud work); verbatim
container output mirrored into the create log; `login` SSE event + `GET` both
carry the state; `POST login-code` writes the code onto the manifest. Real creds
restored, no strays. (Happy-path completion aborted intentionally to avoid
touching real creds — it reuses the battle-tested login core.)



**1a. Extract a reusable login driver.** Factor the pty-login core out of
`_claude-login-worker.ts` into a shared `runClaudeLogin(opts)` (new
`apps/cli/src/lib/claude-login-run.ts`) with injectable sinks so both callers reuse it
without behavior change:
```
runClaudeLogin({
  image, volume, extraArgs,
  writeRaw: (chunk) => void,        // verbatim mirror
  onUrl: (url) => void,             // publish awaiting-code + url
  getCode: () => string | undefined,// poll for the pasted code
  signal,                           // abort/timeout
}): Promise<{ ok: boolean; error?: string }>
```
It keeps the current URL-extraction (`extractOAuthUrl`), 60s URL / 10min code timeouts,
warm-up + `syncClaudeCredentials`. `_claude-login-worker.ts` keeps its file-backed
`LoginState`/`deliverLoginCode` IPC by passing file-backed sinks; behavior identical
(regression-guard: existing `agentbox claude login --headless` must still work).

**1b. Detect + drive login in the create worker.** In `_run-queued-job.ts`, add
`ensureClaudeLoginFresh({ job, log, image, isCloud })` called at the top of
`runDockerJob` and `runCloudJob` **before** `createBox` / `provider.create`, only for
claude jobs. Detection:
- docker: `volumeClaudeCredentials(SHARED_CLAUDE_VOLUME, image)` — needs login when
  `present && !hasRefreshToken` (dead) or absent, and no host env token.
- cloud: `claudeCredStatus(process.env, true)` → `'expired'|'missing'` and no env token.

If login is needed: `writeJob({...job, login:{required:true, phase:'starting'}})`, then call
`runClaudeLogin` with `writeRaw: log.raw`, `onUrl: (url) => writeJob({...login, phase:'awaiting-code', url})`,
`getCode: () => readJob(id).login?.code` (clear it after delivering). On `ok` →
`login.phase='done'`, continue create. On error/timeout → `login.phase='error'` and throw
(job → `failed`, reason surfaced). The job stays `running` while awaiting the code (it
holds a queue slot — acceptable for an interactive gate).

**1c. Manifest field.** Add `login?` (shape above) to `QueueJob` (`queue.ts`). No other
changes — keep `QueueJobStatus` closed; the sub-state is a separate field so no
`status ===` audit is needed.

**1d. Surface via hub API.**
- `getJob` (`hub-backend.ts`) + `JobView` + `HubBackend.getJob` (`backend-types.ts`) carry
  `login`.
- `streamJobLog` (`job-log-stream.ts`): in the existing 500ms `getJob` poll, diff `login`
  against a cached copy and `emit('login', job.login)` on change (single connection, reuses
  the poll).
- v1 `GET /api/v1/jobs/[id]/route.ts`: include `login` in the response.
- **New** `POST /api/v1/jobs/[id]/login-code` (+ internal twin under `api/jobs/[id]/`):
  body `{code}` → `writeJob({...job, login:{...job.login, code}})`. Pure REST (Bearer or
  cookie via the existing `proxy.ts` gate); no server action (keeps hub-web a pure REST
  client). Validate `code` is a non-empty string (mirror `validate.ts` style).

**Verify P1 (no UI):** force expiry, then drive it headlessly via curl.
- Force: cloud path is easiest — set `claudeAiOauth.expiresAt` in
  `~/.agentbox/claude-credentials.json` to the past (back it up first); or blank the volume's
  refresh token for docker. `POST /api/v1/boxes` (agent claude) → get `jobId`.
- `GET /api/v1/jobs/{id}` shows `login.phase:'awaiting-code'` + `url`; the SSE stream emits a
  `login` event; the create log (`~/.agentbox/logs/queue-<id>.log`) contains the verbatim
  container output. Open the `url`, approve, `POST …/login-code {code}` → job proceeds to
  `done` and the box exists. Restore the backup after.

## Phase 2 — Hub web create modal — ✅ DONE + verified (2026-07-04)

Landed in `job-log-stream.tsx` (a `login` SSE listener + a `LoginBanner`: amber
"Claude login required" with a clickable `Open Claude sign-in ↗` link and a code
input that POSTs `/api/v1/jobs/{id}/login-code`, above the byte-for-byte verbatim
`<pre>`) and `create-box-modal.tsx` (a "Login required" `JobStatusBadge` variant).
Verified live in a browser: forced-expiry daytona create → the modal showed the
badge, banner, clickable link, code field, and verbatim container transcript;
submitting a code POSTed it, the worker consumed+cleared it, and a rejected code
came back as the amber `lastError` — full round-trip through the UI.



`job-log-stream.tsx`: `es.addEventListener('login', …)` → `useState` login state; when
`phase==='awaiting-code'`, render a banner above the verbatim `<pre>`: "Claude login
expired — open [url] to approve, then paste the code" with `<a href={url} target="_blank">`
(the clickable link) and a code `<input>` + submit → `fetch('/api/v1/jobs/{id}/login-code',
{POST, body:{code}})`. Show `exchanging`/`error` states. Keep the `<pre>` verbatim
(banner is separate). Add a "Login required" variant to `JobStatusBadge`
(`create-box-modal.tsx`).

**Verify P2:** create a box with forced-expired creds from the hub UI; confirm the banner,
clickable link, code paste → completion, all live.

## Phase 3 — Tray create card — ✅ DONE + verified (2026-07-04)

Landed in the tray repo: `JobLogStreamClient.swift` (parses the `login` SSE event →
`onLogin(JobLoginEvent)`), `HubClient`/`BoxSource`/`LocalCLIBoxSource`
(`submitLoginCode` + `onLogin` threaded through `streamJobLog`), `CreateBoxPanel.swift`
(a login sub-mode: amber "Claude login required" header, clickable "Open Claude
sign-in ↗", a verbatim `NSTextView` transcript, a code field + Submit → `applyLogin`
morphs the card and reverts to the progress card on `phase: done`), and
`AppDelegate.beginCreate` (wires `onLogin` + `onSubmitLoginCode`). Verified live via
the `AGENTBOX_TRAY_TEST_CREATE` hook against a forced-expired backup: the card showed
the header, link, code field, and verbatim container transcript. Code-submit reuses
the same `/login-code` endpoint proven in Phases 1–2.



`CreateBoxPanel.swift`: add a **login mode** to the progress card (it already morphs
states). When the `login` state arrives (via a new `login` SSE event in
`JobLogStreamClient.swift` → `onLogin(phase,url,error)` callback, mirrored through
`BoxSource`/`HubClient` like `updateLog`), swap the card to: a "Claude login expired"
header, a clickable URL (an `NSButton`/link that `NSWorkspace.shared.open`s it), a
multi-line **verbatim** log view (reuse the streamed lines in a scrolling `NSTextView`
instead of the single last-line label), and a code `NSTextField` + Submit that
POSTs `/api/v1/jobs/{id}/login-code` (add `submitLoginCode` to `HubClient`/`BoxSource`).
On `phase==='done'` fall back to the normal progress/terminal flow. Rebuild the bundle
(`make app`) per the tray's build rule.

**Verify P3:** launch the tray with `AGENTBOX_TRAY_TEST_CREATE` (the test hook) against a
forced-expired cred state; confirm the login card renders the link + verbatim log + code
field, paste a real code, and watch it complete and continue into box-created.

## Notes / constraints

- Scope: **Claude only** (codex/opencode have separate creds — out of scope).
- The login container is **host-docker** in all cases (it refreshes the host backup; cloud
  create then syncs it in), so it needs the box image locally — `runClaudeLogin` must ensure
  the image first (reuse the existing ensure-image step from `startHeadlessLogin`).
- Keep public docs in sync: update `apps/web/content/docs/api.mdx` (new `login-code`
  endpoint + `login` on the job/SSE shapes) and the tray `../agentbox-tray/CLAUDE.md`
  (new `login` SSE event + `login-code` POST it depends on).
- Per the repo convention for multi-phase work, mirror this plan into
  `docs/claude-login-refresh-plan.md` and maintain it as phases land.
