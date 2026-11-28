# Sandbox benchmark: performance metrics from real use (plan)

Status: plan, not started (2026-11-28).

## Goal

Measure how sandboxes actually perform while people use them, and publish an anonymous, opt-in,
live benchmark of dev sandboxes on agent-box.sh. The questions it must answer:

- How long does a box take to boot, by provider, size and location?
- How often does each lifecycle step fail, and why (capacity, auth, network, timeout)?
- How fast does the agent run there: output tokens/s, and how often the model API throttles or
  errors (429, overloaded, 5xx). Does a provider's egress IP get throttled more (for example
  Anthropic slowing down datacenter IPs)?
- Where does the time go when a box is slow on the same task: CPU (load, steal, cgroup
  throttling), disk I/O, memory pressure, or waiting on the model?
- How much compute the work used, in a unit comparable across CPUs.

Not a goal: profiling AgentBox itself, or per-user tracking.

## What exists today

Measured by a code survey on 2026-11-28.

| Need | Exists | Gap |
|---|---|---|
| Opt-in anonymous upload | `usage-share.ts`: preview, POST to `agent-box.sh/api/share`, Neon `shares` table, HMAC'd IP, delete secret, per-share `/s/<id>` page | One-shot and manual; no aggregate across shares |
| Boot timing | Job `createdAt/startedAt/finishedAt` (`relay/src/store/store.ts:204`, `queue.ts:140`); activity ledger `box.created/ready/failed` with `at`, `provider`, `agent` | No per-step durations (`CommandLog.step()` exists but create never calls it); the ledger has no size/location |
| Placement | `CloudBoxFields.size/location/landedLocation` (#533) | Docker boxes have neither; no ready timestamp on the box record |
| Error categories | Per-provider error classes (`HetznerApiError`, `classifyPullFailure`, …) | Lifecycle failures reach the job as free strings only |
| Tokens and timing | `history_usage` per message with tokens and `ts_ms`; `history_spans` active intervals | No generation duration: claude needs the gap from the previous record, opencode drops `time.created`, codex/pi have only `ts` |
| API throttling | Auth failures and codex `limits.reached` are parsed | 429/overloaded/5xx are not parsed (raw transcripts are archived, so they can be reparsed) |
| In-box resources | Docker-only host-side `docker stats` (`sandbox-docker/src/stats.ts`) | Nothing inside the box reads `/proc/stat` steal, PSI, cgroup `cpu.stat` or `/proc/diskstats` |
| Box→hub channel | ctl `box-status` every 15 s, additive fields allowed (`ctl/src/status-reporter.ts`) | Carries no resource data |
| Public page | apps/web has server routes + Neon | No aggregate/stats page |

## Design in one paragraph

Each hub collects its own perf records: boot step durations and error categories from the create
worker, resource samples from ctl over the existing `box-status` channel, and throughput and
API-error events from the history it already ingests. The hub keeps them locally, shows them on a
Performance page, and, only if the user opts in, periodically uploads an aggregate (histograms
keyed by provider, size, location, agent and model: never box, project, repo or session names) to
agent-box.sh, which merges every submission into a public live benchmark. Everything runs behind
`/api/v1`, so the CLI, web UI and tray share it, and it works for every provider, docker included.

## Phases

### Phase 0: measurements (PoC, gates the rest)

On a live box of each provider (docker on Mac, docker on Linux, hetzner, digitalocean, daytona,
vercel, e2b, remote-docker), record which signals are readable from inside the box and what they
cost:

- CPU: `/proc/stat` (including `steal`), `/sys/fs/cgroup/cpu.stat` (`nr_throttled`,
  `throttled_usec`), `/proc/pressure/{cpu,io,memory}`, `nproc` vs the cgroup quota. Firecracker
  (vercel, e2b) and Daytona may hide some of these.
- Disk: `/proc/diskstats` deltas on the workspace device; a short `fio`-free probe (write and
  fsync 64 MB, read it back) and its cost in seconds.
- Compute unit: whether `perf_event_open` instruction counters work anywhere (they rarely do in
  VMs). If not, define a calibrated work score: a fixed single-thread kernel (for example sha256 over
  a fixed buffer) timed once at boot, giving "work units per CPU-second" so CPU-seconds used can be
  converted to a comparable figure. This is the answer to "MIPS used per minute".
- Throughput: from the stored transcripts, compute output tokens/s for claude and codex turns and
  check it against wall clock; find the 429/overloaded/5xx records in raw claude and codex
  transcripts and how they look.
- Overhead: the sampler's CPU and memory cost at a 15 s cadence.

Output: a table in this doc, per provider, of signal x {readable, cost, quirks}. Drop any metric no
provider exposes.

### Phase 1: lifecycle timing and errors (hub-local)

- Call `CommandLog.step()` around each create step in every provider path and the hub worker, and
  record `{step, ms, ok}` on the job.
- Record `readyAt` on the box record and size/location on the activity ledger rows.
- An error classifier at the worker boundary maps provider errors to an enum (`capacity`,
  `quota`, `auth`, `network`, `timeout`, `image`, `provider-5xx`, `agent-login`, `unknown`),
  stored beside the existing message.
- Covers create, start, resume, stop, checkpoint and push.

### Phase 2: in-box resource sampler (ctl)

- ctl samples the Phase 0 signals every 15 s and adds a compact `resources` field to `box-status`
  (additive, schema stays 1): CPU busy %, steal %, throttled ms, PSI some/full for cpu/io/memory,
  disk read/write bytes and ops, load, memory and swap use.
- The hub folds samples into per-box minute buckets in a new store slice
  (`apps/hub/lib/backend/perf.ts`, not `hub-backend.ts`), with a retention cap.
- Every provider gets it for free because ctl runs in every box. Docker's host-side `docker stats`
  stays as a cross-check.

### Phase 3: agent throughput and model throttling

- Per turn: output tokens, generation duration, tokens/s, time to first token where the agent
  records it. claude: the gap from the previous record; opencode: keep `time.created`; codex/pi:
  whatever Phase 0 found.
- Parse API error events (429, overloaded/529, 5xx, timeouts) for every agent, and count them per
  model, provider and location.
- Busy vs idle per box: agent working, waiting on the model, waiting on tools, idle, from the
  status timeline plus spans.
- Throttling by egress IP: compare tokens/s and API error rate per provider/location for the same
  model and hour of day. That is the evidence for "Anthropic throttles some IPs".

### Phase 4: local Performance view

- `/api/v1/perf/*` routes; a hub Performance page (boot time by provider/size/location, failure
  rates, tokens/s per agent/model, per-box resource timeline that marks steal, throttling and I/O
  stalls); `agentbox perf` in the CLI. Tray: a slow-box indicator, if Phase 2 shows it is useful.

### Phase 5: opt-in anonymous submission

- Config key `bench.share` (`off` by default, with `--bench-share` and a hub Settings toggle),
  asked once in the wizard with the exact JSON preview, like usage sharing.
- Payload: aggregates only, per day: histograms and counts keyed by provider, size, location
  (region), agent, model, CPU work score bucket. No box/project/repo/branch/session names, no host
  names, no timestamps finer than the day. A random submitter id that rotates monthly, kept only
  to de-duplicate retries.
- Cadence: daily, skipped when unchanged; the user can delete their submissions (delete secret, as
  for shares).
- Receiver: `apps/web` `POST /api/bench` + Neon tables (raw submissions + rolled-up aggregates),
  rate limit by HMAC'd IP, strict schema with enums.

### Phase 6: public benchmark page

- `agent-box.sh/bench`: boot time, failure rate, tokens/s and API error rate, and resource
  pressure, by provider/size/location/agent/model, with sample counts and a minimum-sample
  threshold before a cell is shown. Methodology section: what is measured, how, and the opt-in.
- Revalidated on new data (ISR), as the share pages are.

## Open questions for the owner

1. Default for `bench.share`: off with a one-time ask (proposed), or on by default with a notice?
2. Should a submission include the model API error rate and tokens/s by egress location? It is
   the most interesting number, and also the most sensitive for providers and model vendors.
3. Is the CPU work score acceptable as the "MIPS" figure, if Phase 0 confirms instruction counters
   are unavailable in most sandboxes?
4. Should the local Performance page ship before the public page (proposed order above), or should
   both land together?
