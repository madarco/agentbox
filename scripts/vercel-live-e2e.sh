#!/usr/bin/env bash
#
# vercel-live-e2e.sh — drive the remaining P0 live-smoke items for the Vercel
# provider (docs/vercel-backlog.md): pause/resume (#5), checkpoint round-trip
# (#6), and (opt-in) relay round-trip (#4).
#
# WHY this exists: the boot path was validated live 2026-05-28, but pause/resume,
# the checkpoint round-trip, and the relay round-trip were never exercised. This
# script automates them from a context that holds a VERCEL_TOKEN trio. It
# deliberately avoids the laggy attach bridge: box state is read from the LIVE
# Vercel SDK (test/live-state.mjs — `agentbox list` reports cloud boxes as
# optimistically 'running'), the /workspace marker travels over `agentbox cp`
# (relay-backed provider transfer), and the snapshot id is read straight from the
# checkpoint manifest.
#
# Usage:
#   VERCEL_TOKEN=... VERCEL_TEAM_ID=... VERCEL_PROJECT_ID=... \
#     AGENTBOX_BIN="node $PWD/apps/cli/dist/index.js" bash scripts/vercel-live-e2e.sh
#
# Flags / env:
#   --keep            leave boxes + checkpoint behind for inspection (no cleanup)
#   --prepare         run `agentbox prepare --provider vercel` first if no base
#   E2E_RELAY=1       also attempt the relay round-trip (#4); needs a pushable
#                     origin reachable by the host relay (see Phase D notes)
#   AGENTBOX_BIN=...  explicit CLI command (default: agentbox on PATH, else
#                     node <repo>/apps/cli/dist/index.js). The published CLI
#                     can't do --provider vercel yet, so use the monorepo dist.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUF="$(date +%s)"
KEEP=0
PREPARE=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --prepare) PREPARE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ -n "${AGENTBOX_BIN:-}" ]]; then
  # shellcheck disable=SC2206
  AB=($AGENTBOX_BIN)
elif command -v agentbox >/dev/null 2>&1; then
  AB=(agentbox)
else
  AB=(node "$REPO_ROOT/apps/cli/dist/index.js")
fi

BOX="vfe-$SUF"
RESTORE="vfe-restore-$SUF"
CKPT="vfe-ckpt-$SUF"
MARKER_VAL="agentbox-e2e-$SUF"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
info() { printf '\n=== %s\n' "$*"; }
pass() { PASS=$((PASS + 1)); c_green "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); c_red "FAIL: $*"; }

# LIVE Vercel status of a box, by name. We do NOT use `agentbox list` for state:
# it reports cloud boxes as optimistically 'running' with no SDK probe
# (sandbox-docker/src/lifecycle.ts — "tracked for Phase 6"), so it can never see
# a stopped box. The helper reads the provider directly.
LIVE_STATE=(node "$REPO_ROOT/packages/sandbox-vercel/test/live-state.mjs")
live_status() { "${LIVE_STATE[@]}" "$1" 2>/dev/null || echo "err"; }

# Poll live status until it equals $2 (or timeout $3 seconds). Prints transitions.
poll_status() {
  local box="$1" want="$2" timeout="$3" t=0 s
  while [[ "$t" -lt "$timeout" ]]; do
    s="$(live_status "$box")"
    echo "  [t=${t}s] live status of $box: $s"
    [[ "$s" == "$want" ]] && return 0
    sleep 6
    t=$((t + 6))
  done
  return 1
}

box_provider() {
  "${AB[@]}" list -j -g 2>/dev/null | node -e '
    const fs = require("fs");
    let d; try { d = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
    const arr = Array.isArray(d) ? d : (d.boxes || d.items || []);
    const b = arr.find((x) => x.name === process.argv[1]);
    process.stdout.write(b ? String(b.provider ?? "docker") : "");
  ' "$1"
}

cleanup() {
  local code=$?
  if [[ "$KEEP" == "1" ]]; then
    info "--keep set; leaving $BOX / $RESTORE / checkpoint $CKPT in place"
  else
    info "cleanup"
    "${AB[@]}" destroy "$BOX" -y >/dev/null 2>&1 || true
    "${AB[@]}" destroy "$RESTORE" -y >/dev/null 2>&1 || true
    "${AB[@]}" checkpoint rm "$CKPT" -y >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
  echo
  printf 'summary: %d passed, %d failed\n' "$PASS" "$FAIL"
  if [[ "$FAIL" -gt 0 && "$code" == "0" ]]; then exit 1; fi
  exit "$code"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
info "preconditions"
if [[ -z "${VERCEL_TOKEN:-}" && -z "${VERCEL_OIDC_TOKEN:-}" ]]; then
  fail "no Vercel credential in env (set the VERCEL_TOKEN trio — OIDC tends to be expired)"
  exit 1
fi
if [[ -n "${VERCEL_TOKEN:-}" ]]; then
  [[ -n "${VERCEL_TEAM_ID:-}" && -n "${VERCEL_PROJECT_ID:-}" ]] \
    || { fail "VERCEL_TOKEN set but VERCEL_TEAM_ID / VERCEL_PROJECT_ID missing"; exit 1; }
  pass "VERCEL_TOKEN trio present"
else
  c_red "note: using VERCEL_OIDC_TOKEN — it likely expires mid-run; the token trio is the practical path"
fi

if [[ ! -f "$HOME/.agentbox/vercel-prepared.json" ]]; then
  if [[ "$PREPARE" == "1" ]]; then
    info "no base snapshot; running prepare (slow)"
    "${AB[@]}" prepare --provider vercel
  else
    fail "no base snapshot (~/.agentbox/vercel-prepared.json). Run with --prepare or 'agentbox prepare --provider vercel' first"
    exit 1
  fi
fi
pass "base snapshot recorded"

# ---------------------------------------------------------------------------
# Phase A — create
# ---------------------------------------------------------------------------
info "Phase A: create $BOX"
# --carry skip: this is a lifecycle smoke, not a carry test; skipping avoids the
# non-TTY carry-approval gate when the workspace's agentbox.yaml has a carry block.
"${AB[@]}" create --provider vercel -n "$BOX" -y --carry skip
[[ "$(box_provider "$BOX")" == "vercel" ]] && pass "box provider == vercel" || fail "box provider != vercel"
poll_status "$BOX" running 90 && pass "box running after create" || fail "box not running after create"

# ---------------------------------------------------------------------------
# Phase B — pause / resume (#5)
# ---------------------------------------------------------------------------
info "Phase B: pause/resume + /workspace survival (#5)"
printf '%s' "$MARKER_VAL" > "$TMP/AGENTBOX_E2E_MARKER"
"${AB[@]}" cp "$TMP/AGENTBOX_E2E_MARKER" "$BOX:/workspace/"

URL1="$("${AB[@]}" url "$BOX" --print 2>/dev/null || true)"
[[ -n "$URL1" ]] && echo "preview URL before stop: $URL1" || echo "preview URL before stop: (none / not exposed)"

# stop auto-snapshots; the VM transitions running -> stopping -> stopped (~20s).
"${AB[@]}" stop "$BOX"
poll_status "$BOX" stopped 150 && pass "box stopped (auto-snapshot)" || fail "box did not reach 'stopped' in 150s"

# start resumes lazily from the auto-snapshot.
"${AB[@]}" start "$BOX"
poll_status "$BOX" running 150 && pass "box running after start (resume)" || fail "box did not resume in 150s"

rm -f "$TMP/marker.out"
"${AB[@]}" cp "$BOX:/workspace/AGENTBOX_E2E_MARKER" "$TMP/marker.out"
if [[ -f "$TMP/marker.out" && "$(cat "$TMP/marker.out")" == "$MARKER_VAL" ]]; then
  pass "/workspace marker survived stop/start"
else
  fail "/workspace marker lost or wrong after stop/start"
fi

URL2="$("${AB[@]}" url "$BOX" --print 2>/dev/null || true)"
echo "preview URL after start:  ${URL2:-(none)}"
if [[ -n "$URL1" && -n "$URL2" ]]; then
  [[ "$URL1" == "$URL2" ]] && echo "info: preview URL stable across stop/start" \
    || echo "info: preview URL ROTATED across stop/start (expected per backlog #5 — note it)"
fi

# ---------------------------------------------------------------------------
# Phase C — checkpoint round-trip (#6)
# ---------------------------------------------------------------------------
info "Phase C: checkpoint round-trip (#6)"
"${AB[@]}" checkpoint create "$BOX" --name "$CKPT" --replace

MANIFEST="$(ls "$HOME"/.agentbox/cloud-checkpoints/vercel/*/"$CKPT"/manifest.json 2>/dev/null | head -1 || true)"
if [[ -n "$MANIFEST" ]]; then
  SNAP_ID="$(node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(m.snapshotName ?? ""));
  ' "$MANIFEST")"
  [[ -n "$SNAP_ID" ]] && pass "manifest stores vercel snapshot id ($SNAP_ID)" \
    || fail "manifest has empty snapshotName"
else
  fail "no checkpoint manifest at ~/.agentbox/cloud-checkpoints/vercel/*/$CKPT/manifest.json"
fi

"${AB[@]}" create --provider vercel --snapshot "$CKPT" -n "$RESTORE" -y --carry skip
poll_status "$RESTORE" running 90 && pass "restored box running from --snapshot $CKPT" \
  || fail "restored box not running"

rm -f "$TMP/marker.restore"
"${AB[@]}" cp "$RESTORE:/workspace/AGENTBOX_E2E_MARKER" "$TMP/marker.restore" 2>/dev/null || true
if [[ -f "$TMP/marker.restore" && "$(cat "$TMP/marker.restore")" == "$MARKER_VAL" ]]; then
  pass "checkpoint captured /workspace state (marker present in restored box)"
else
  fail "marker missing from restored box — checkpoint did not capture /workspace"
fi

# ---------------------------------------------------------------------------
# Phase D — relay round-trip (#4) — opt-in (needs a pushable origin)
# ---------------------------------------------------------------------------
info "Phase D: relay round-trip (#4)"
if [[ "${E2E_RELAY:-0}" == "1" ]]; then
  PROBE_BRANCH="agentbox/$BOX"
  # GROUND TRUTH: do NOT trust the `agentbox shell ... git push` exit code — on
  # vercel `shell` goes through the laggy attach pump whose exit code reflects the
  # attach wrapper, not the in-box command (this produced a false PASS on
  # 2026-05-29: the wrapper exited 0 but nothing reached origin). The only
  # reliable gate is "did the probe commit actually land on origin?", checked
  # with `git ls-remote` from a repo that shares the same origin.
  GIT_REMOTE_REPO="${E2E_GIT_REPO:-$PWD}"
  if ! git -C "$GIT_REMOTE_REPO" ls-remote origin >/dev/null 2>&1; then
    fail "no reachable origin at $GIT_REMOTE_REPO (set E2E_GIT_REPO=<repo with a pushable origin>)"
  else
    pre="$(git -C "$GIT_REMOTE_REPO" ls-remote origin "refs/heads/$PROBE_BRANCH" 2>/dev/null | awk '{print $1}')"
    echo "pre-push: origin $PROBE_BRANCH = ${pre:-<absent>}"
    echo "triggering in-box commit + 'agentbox-ctl git push' via the relay (attach is laggy — be patient)..."
    "${AB[@]}" shell "$BOX" -- bash -lc '
      set -e
      cd /workspace
      git config user.email e2e@agentbox.local
      git config user.name agentbox-e2e
      date > AGENTBOX_RELAY_PROBE
      git add AGENTBOX_RELAY_PROBE
      git commit -m "e2e relay probe '"$MARKER_VAL"'" >/dev/null
      agentbox-ctl git push
    ' || echo "note: attach wrapper returned non-zero (unreliable on vercel) — verifying via origin instead"
    # Poll origin for the box branch (the relay push is async via the poller).
    pushed=""
    for _ in $(seq 1 20); do
      cur="$(git -C "$GIT_REMOTE_REPO" ls-remote origin "refs/heads/$PROBE_BRANCH" 2>/dev/null | awk '{print $1}')"
      if [[ -n "$cur" && "$cur" != "$pre" ]]; then pushed="$cur"; break; fi
      sleep 6
    done
    if [[ -n "$pushed" ]]; then
      pass "relay round-trip: probe commit $pushed landed on origin $PROBE_BRANCH (verified via git ls-remote)"
    else
      fail "relay round-trip: probe commit never appeared on origin $PROBE_BRANCH within 120s (push did NOT complete through the relay)"
    fi
  fi
else
  cat <<EOF
SKIPPED (set E2E_RELAY=1 to attempt). Manual runbook:
  1. Ensure the host relay is running and the box's origin is pushable by the host.
  2. agentbox shell $BOX
  3. cd /workspace && echo probe > AGENTBOX_RELAY_PROBE && git add -A && git commit -m probe
  4. agentbox-ctl git push        # routes through the in-box relay client -> host relay
  5. On the host: git ls-remote origin agentbox/$BOX  -> should show the probe commit
  6. Also try: agentbox-ctl git pull, and a 'gh pr' command from inside the box.
EOF
fi

# ---------------------------------------------------------------------------
# Regression: destroy preserves the shared base (the 2026-05-28 bug #1)
# ---------------------------------------------------------------------------
info "Regression: destroy preserves the base snapshot"
"${AB[@]}" destroy "$RESTORE" -y >/dev/null 2>&1 || true
"${AB[@]}" destroy "$BOX" -y >/dev/null 2>&1 || true
BASECHECK="vfe-basecheck-$SUF"
if "${AB[@]}" create --provider vercel -n "$BASECHECK" -y --carry skip; then
  poll_status "$BASECHECK" running 90 \
    && pass "base snapshot still bootable after destroys (guard holds)" \
    || fail "base-check box not running"
  "${AB[@]}" destroy "$BASECHECK" -y >/dev/null 2>&1 || true
else
  fail "could not create from base after destroys — base may have been deleted (410?)"
fi
