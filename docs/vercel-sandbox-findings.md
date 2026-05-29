# Vercel Sandbox — findings & gotchas (to share with Vercel)

Context: we built a provider for [AgentBox](https://github.com/madarco/agentbox)
on top of **`@vercel/sandbox@2.0.1`**, baking a base environment once via
`sandbox.snapshot()` and booting per-task sandboxes from it (Amazon Linux 2023,
`node24` runtime image, Firecracker microVM, `iad1`). Auth via a personal access
token trio (`VERCEL_TOKEN` + team id + project id). Everything below was observed
live on 2026-05-28; nothing here is a guess.

We're sharing this as constructive feedback — the platform worked well overall
(snapshot bake + boot in well under a minute, persistent stop/resume, public
preview URLs all behaved). These are the rough edges that cost us real debugging
time.

## Bugs / surprising behavior

### 1. AL2023 base `/etc/sudoers` has no `@includedir /etc/sudoers.d` and wrong perms

**Highest-impact issue for us.** On the `node24` Amazon Linux 2023 base image:

- `/etc/sudoers` does **not** contain an `@includedir /etc/sudoers.d` (nor the
  legacy `#includedir`) directive, so **any drop-in file under `/etc/sudoers.d/`
  is silently ignored.**
- `visudo -cf /etc/sudoers` reports `/etc/sudoers: bad permissions, should be
  mode 0440` — i.e. the base file's permissions are not what sudo expects.

Net effect: a standard, idiomatic setup — create a user, drop
`/etc/sudoers.d/90-myuser` with `myuser ALL=(ALL) NOPASSWD: ALL`, `chmod 0440` —
does **nothing**. `sudo -n` as that user fails with `sudo: a password is
required`, which is baffling because the drop-in is present, correct, and
0440-owned-by-root.

Repro (from a sandbox booted on the base):
```
$ cat /etc/sudoers.d/90-foo            # vscode ALL=(ALL) NOPASSWD: ALL  (0440 root:root)
$ grep includedir /etc/sudoers         # (no match)
$ sudo -u foo sudo -n true             # sudo: a password is required
$ visudo -cf /etc/sudoers              # /etc/sudoers: bad permissions, should be mode 0440
```

Our workaround: append `@includedir /etc/sudoers.d` to `/etc/sudoers`, `chmod
0440 /etc/sudoers`, then `visudo -cf` to validate, during the snapshot bake.

Suggestion: ship the AL2023 base with a standard sudoers that includes
`/etc/sudoers.d` and is mode 0440 (matching Debian/Ubuntu and stock AL2023
cloud images), so drop-ins work as expected.

### 2. `Snapshot.get()` resolves deleted/failed snapshots instead of failing

`Snapshot.get({ snapshotId })` returns a value for snapshots that have been
**deleted or failed** — a tombstone with `status: 'deleted' | 'failed'` and
`sizeBytes: 0` — rather than throwing or 404-ing. So "`get` didn't throw" does
**not** mean "usable": a subsequent `Sandbox.create({ source: { type:
'snapshot', snapshotId }})` from a `deleted` snapshot fails with a 410.

This made our "does the base snapshot already exist?" fast-path wrong — it
treated a deleted base as present and skipped the rebuild. We now gate on
`status === 'created'`.

Suggestion: either throw/404 from `get` for non-existent snapshots, or document
the `status` field prominently as the gate for usability.

### 3. A fresh sandbox's `currentSnapshotId` equals its `sourceSnapshotId`

A sandbox created from a snapshot reports `currentSnapshotId ===
sourceSnapshotId === <the snapshot it booted from>`, and only diverges once it
stops/auto-snapshots itself.

This is an easy footgun: a naive cleanup that deletes `currentSnapshotId` on
teardown will delete the **shared source snapshot** that every other sandbox was
created from — breaking all later `create`s from it with 410s. We had to guard
teardown with `currentSnapshotId !== sourceSnapshotId`.

Suggestion: leave `currentSnapshotId` unset/null until the sandbox creates its
own snapshot, or document this aliasing clearly.

### 4. `Sandbox.list()` vs `Sandbox.get()` inconsistency for stopped/expired sandboxes

`Sandbox.list()` keeps returning recently-stopped/expired sandboxes (with
`status: 'stopped'`), but `Sandbox.get({ sandboxId })` on the same name then
returns **404**. Also, the items returned by `list()` are summaries without a
`.delete()` method, so cleanup requires `get()` → `.delete()` — which 404s for
exactly these lingering entries. The result is "ghost" sandboxes that show up in
`list()` but can't be acted on; they eventually age out.

Suggestion: make `list()` and `get()` agree on lifecycle state, and/or expose
delete on the list summaries (or accept a delete-by-id that tolerates
already-reaped sandboxes).

### 5. OIDC dev tokens can't be used headlessly without the Vercel CLI

`VERCEL_OIDC_TOKEN` from `vercel env pull` lasts ~12h and the SDK's env-OIDC path
(`@vercel/oidc`) tries to **refresh** it via the local Vercel CLI's
`.vercel/project.json` + cached auth. In a headless sandbox/CI box that linkage
doesn't exist, so it fails with `Could not get credentials from OIDC context` —
even though the token itself is still a valid bearer.

Our workaround: decode the OIDC JWT's `owner_id`/`project_id` claims and pass
`{ token, teamId, projectId }` explicitly (the SDK's direct-credentials path),
which works. But the practical path for any long-running operation (our base
bake takes a few minutes and can outlive a token) ended up being the
non-expiring access-token trio.

Suggestion: support a non-CLI OIDC code path (use the token directly as a bearer
without attempting a CLI-backed refresh), and/or offer longer-lived tokens for
CI/headless use.

## Platform constraints we worked around (not bugs — for your awareness)

- **No nested containers.** seccomp blocks `clone`/`unshare` of new namespaces
  and there's no `CAP_SYS_ADMIN`, so no Docker/Podman/buildah inside a sandbox
  (rootless or rootful). We disable our in-box Docker on this provider. This is a
  reasonable isolation boundary; just worth stating explicitly in the docs.
- **`tigervnc-server` + `websockify` on AL2023.** Our VNC stack (Xvnc +
  websockify + noVNC), written for Debian/Ubuntu, doesn't come up on AL2023
  (websockify never binds its port). Likely our packaging, but flagging in case
  the AL2023 package set differs in a way you'd want to document.
- **Resource/region limits.** `iad1` only, ≤4 exposed ports, RAM coupled to vCPU
  count, max session length (45 min Hobby / 5 hr Pro+). All fine for us once
  known; a one-page "sandbox limits" reference would help.

## What worked well

- `sandbox.snapshot()` bake → `Sandbox.create({ source: snapshot })` boot is fast
  (~30–60s boot from a ~1.3 GB base) and reliable.
- Persistent sandboxes: `stop` auto-snapshots and `get({ resume: true })` resumes
  with the filesystem intact — clean mapping to pause/resume. Live status
  transitions (`running → stopping → stopped`) are observable and quick (~18s).
- Public `sandbox.domain(port)` preview URLs (HTTPS + WebSocket) were stable
  across a stop/start cycle (did not rotate).
- `writeFiles` / `runCommand({ sudo: true })` / `readdir` / `downloadFile` were
  straightforward to build a file-transfer + exec layer on.
