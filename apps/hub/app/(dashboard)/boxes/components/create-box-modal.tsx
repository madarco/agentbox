'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { createBoxAction, listBranchesAction } from '@/lib/boxes/actions';
import type { CreateBoxInput } from '@/lib/boxes/backend-types';
import { useStore } from '@/lib/boxes/store';
import type { Project, ProviderOption } from '@/lib/boxes/types';
import { cn } from '@/lib/utils';
import { JobLogStream, type JobLoginState } from './job-log-stream';

type Agent = CreateBoxInput['agent'];

// Docker is always available; used when the server sent no provider list (the
// hosted/Postgres path, where host readiness isn't known).
const DOCKER_ONLY: ProviderOption[] = [{ id: 'docker', label: 'Docker (local)', configured: true }];

// Button + modal to create a box. Pass `project` to lock it (project page /
// per-project row); pass `projects` for a picker (no fixed project).
export function CreateBoxButton({
  project,
  projects,
  variant,
  size,
  className,
}: {
  project?: Project;
  projects?: Project[];
  variant?: 'default' | 'outline';
  size?: 'sm';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} className={className} onClick={() => setOpen(true)}>
        <Icons.plus />
        Create box
      </Button>
      {open ? (
        <CreateBoxModal
          project={project}
          projects={projects ?? (project ? [project] : [])}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function CreateBoxModal({
  project,
  projects,
  onClose,
}: {
  project?: Project;
  projects: Project[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { state } = useStore();
  const providers = state.providers.length ? state.providers : DOCKER_ONLY;
  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState(project?.id ?? projects[0]?.id ?? '');
  const [agent, setAgent] = useState<Agent>('claude');
  const [provider, setProvider] = useState<CreateBoxInput['provider']>('docker');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [fromBranch, setFromBranch] = useState('');
  const [branches, setBranches] = useState<string[] | null>(null);
  const [runSetup, setRunSetup] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string>('streaming');
  const [loginPhase, setLoginPhase] = useState<JobLoginState['phase'] | null>(null);
  // Two-phase create: when the provider's base image needs baking, a prepare
  // job runs first (bakeJobId) and the create fires on its `end: done`.
  const [bakeJobId, setBakeJobId] = useState<string | null>(null);
  // Cloud-provider stale base: the footer swaps to a rebuild-vs-use-existing
  // choice (mirrors the CLI wizard's stale-base prompt).
  const [staleChoice, setStaleChoice] = useState(false);
  // Base freshness is off the getData() hot path — fetched once via the
  // opt-in endpoint and merged onto the store providers (same pattern as
  // the settings ProvidersSection).
  const [freshness, setFreshness] = useState<Record<
    string,
    Pick<ProviderOption, 'baseStatus' | 'baseStaleReason' | 'jobId'>
  > | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/providers?freshness=1', { credentials: 'same-origin' });
        if (!res.ok) return;
        const j = (await res.json()) as { providers?: ProviderOption[] };
        if (cancelled) return;
        const map: Record<string, Pick<ProviderOption, 'baseStatus' | 'baseStaleReason' | 'jobId'>> = {};
        for (const p of j.providers ?? []) {
          map[p.id] = { baseStatus: p.baseStatus, baseStaleReason: p.baseStaleReason, jobId: p.jobId };
        }
        setFreshness(map);
      } catch {
        // Best-effort: without freshness the create simply bakes inline (docker self-heals).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = projects.find((p) => p.id === projectId) ?? project;
  // `provider` state always holds a concrete id (init 'docker'), but its TYPE is optional.
  const providerId = provider ?? 'docker';
  const providerOption = providers.find((p) => p.id === providerId);
  const providerFreshness = freshness?.[providerId];
  // An in-flight bake job counts as "bake needed" too — the create must wait on it.
  const bakeNeeded =
    !!providerFreshness &&
    (!!providerFreshness.jobId ||
      providerFreshness.baseStatus === 'unprepared' ||
      providerFreshness.baseStatus === 'stale');

  // Load the selected project's branches for the base-branch picker, and default
  // the base + setup-wizard toggle from the project. Re-runs when the project
  // changes. Ignored once the build job has started (the form is gone).
  useEffect(() => {
    if (!projectId || jobId) return;
    setRunSetup(selected?.needsSetup ?? false);
    // Reset the provider to the default on a project switch (like branch/setup) so
    // a cloud provider picked for one project doesn't silently carry to the next.
    setProvider('docker');
    let cancelled = false;
    setBranches(null);
    setFromBranch(selected?.currentBranch ?? '');
    void listBranchesAction(projectId).then((res) => {
      if (cancelled || !res.ok) {
        if (!cancelled && !res.ok) setBranches([]);
        return;
      }
      setBranches(res.branches);
      // Default to the repo's current HEAD when it's in the list.
      if (res.current && res.branches.includes(res.current)) setFromBranch(res.current);
    });
    return () => {
      cancelled = true;
    };
    // `selected` is derived from projectId (+ the static projects prop), so keying
    // the effect on projectId/jobId is sufficient.
  }, [projectId, jobId]);

  const submit = () => {
    setError(null);
    if (!projectId) {
      setError('pick a project');
      return;
    }
    if (bakeNeeded) {
      // Docker auto-bakes (its base self-heals — same rule as the CLI); a
      // stale CLOUD base gets the CLI wizard's rebuild-vs-use-existing choice.
      // An in-flight bake is never re-asked — the create just waits on it.
      if (providerId !== 'docker' && providerFreshness?.baseStatus === 'stale' && !providerFreshness.jobId) {
        setStaleChoice(true);
        return;
      }
      startBake();
      return;
    }
    startCreate();
  };

  // Phase 1: bake the provider's base image (or attach to an in-flight bake).
  // `startCreate` fires from the bake stream's `end: done`.
  const startBake = () => {
    setError(null);
    const inFlight = providerFreshness?.jobId;
    if (inFlight) {
      setBakeJobId(inFlight);
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/v1/providers/${encodeURIComponent(providerId)}/prepare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          // No force: a fresh-again base becomes a fast no-op job; a stale
          // fingerprint still triggers the rebuild.
          body: JSON.stringify({}),
        });
        const j = (await res.json().catch(() => null)) as
          | { jobId?: string; error?: { message?: string } }
          | null;
        if (!res.ok || !j?.jobId) {
          setError(j?.error?.message ?? `base image build request failed (${res.status})`);
          return;
        }
        setBakeJobId(j.jobId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const startCreate = () => {
    setError(null);
    startTransition(async () => {
      const res = await createBoxAction({
        projectId,
        agent,
        provider,
        name: name.trim() || undefined,
        prompt: agent === 'none' ? undefined : prompt.trim() || undefined,
        // Only pin an explicit base when it differs from the current branch; leaving the current
        // branch selected bases the box on the host's literal HEAD (like `agentbox create` with no
        // --from-branch) and skips a redundant fetch. Uncommitted + untracked files carry over either way.
        fromBranch:
          fromBranch.trim() && fromBranch.trim() !== selected?.currentBranch ? fromBranch.trim() : undefined,
        setupWizard: agent !== 'none' && runSetup,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setJobId(res.jobId);
      router.refresh(); // surface the box as `creating`
    });
  };

  return (
    // Widen the dialog while the build log streams so long lines are readable.
    <Dialog onClose={onClose} className={jobId || bakeJobId ? 'max-w-[900px]' : 'max-w-[560px]'}>
      <DialogHeader>
        <DialogIcon>
          <Icons.box />
        </DialogIcon>
        <div>
          <DialogTitle>{!jobId && bakeJobId ? 'Building base image' : 'Create box'}</DialogTitle>
          <DialogDescription>{selected ? selected.name : 'Start a box in a project'}</DialogDescription>
        </div>
        {/* Live job state next to the close button: pulsating while working, a pill when settled. */}
        {jobId || bakeJobId ? (
          <div className="ml-auto mr-8 flex-none pt-0.5">
            <JobStatusBadge status={jobStatus} loginPhase={loginPhase} />
          </div>
        ) : null}
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        {jobId ? (
          <JobLogStream
            jobId={jobId}
            onStatus={setJobStatus}
            onDone={() => router.refresh()}
            onLogin={(l) => setLoginPhase(l?.phase ?? null)}
          />
        ) : bakeJobId ? (
          // Phase 1: the base-image bake streams here; `end: done` fires the create,
          // which swaps this for the create job's stream above.
          <>
            <p className="font-mono text-xs text-muted-foreground">
              Building the {providerOption?.label ?? providerId} base image — one-time, can take several
              minutes. The box is created automatically when it finishes.
            </p>
            <JobLogStream
              jobId={bakeJobId}
              onStatus={setJobStatus}
              onDone={(status) => {
                if (status === 'done') startCreate();
                else setError(`base image build ${status}`);
              }}
            />
            {error ? <div className="font-mono text-xs text-destructive">{error}</div> : null}
          </>
        ) : (
          <>
            {!project ? (
              <Field label="Project">
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.length === 0 ? <option value="">No projects — add one first</option> : null}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Provider">
              <Select value={provider} onChange={(e) => setProvider(e.target.value as CreateBoxInput['provider'])}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.configured} title={p.reason}>
                    {p.label}
                    {p.configured ? '' : ' — not configured'}
                  </option>
                ))}
              </Select>
            </Field>
            {bakeNeeded ? (
              <p
                className="-mt-2 font-mono text-xs text-amber-600 dark:text-amber-400"
                title={providerFreshness?.baseStaleReason}
              >
                {providerFreshness?.jobId
                  ? 'A base-image build is already running — the box will be created when it finishes.'
                  : providerFreshness?.baseStatus === 'unprepared'
                    ? 'First use of this provider: the base image will be downloaded or built first (can take 5–10 minutes).'
                    : 'The base image is out of date and will be rebuilt first (can take 5–10 minutes).'}
              </p>
            ) : null}
            <Field label="Agent">
              <Select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="opencode">OpenCode</option>
                <option value="none">Empty — just create the box</option>
              </Select>
            </Field>
            <Field label="Name (optional)">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="auto" />
            </Field>
            {selected?.needsSetup && agent !== 'none' ? (
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={runSetup}
                  onChange={(e) => setRunSetup(e.target.checked)}
                  className="mt-0.5 h-4 w-4 flex-none accent-primary"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-secondary-foreground">Run setup wizard</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    This project has no agentbox.yaml — the agent explores the repo and proposes one on its first
                    turn.
                  </span>
                </span>
              </label>
            ) : null}
            {agent === 'none' ? (
              <p className="font-mono text-xs text-muted-foreground">
                The box is created and left running with no agent — attach later from a terminal or SSH
                (<span className="text-secondary-foreground">agentbox shell</span>).
              </p>
            ) : null}
            {/* Advanced: base branch + initial prompt, collapsed to keep the form lean. */}
            <div className="flex flex-col gap-4">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex cursor-pointer items-center gap-1.5 self-start text-xs font-medium text-secondary-foreground transition-colors hover:text-foreground"
              >
                <Icons.chevR className={cn('size-3.5 transition-transform', showAdvanced && 'rotate-90')} />
                Advanced
              </button>
              {showAdvanced ? (
                <>
                  {/* Base branch picker: the box forks its per-box branch from this ref.
                      Hidden on the hosted path (no local repo → empty branch list). */}
                  {branches === null ? (
                    <Field label="Base branch">
                      <Select value="" disabled>
                        <option value="">Loading branches…</option>
                      </Select>
                    </Field>
                  ) : branches.length > 0 ? (
                    <Field label="Base branch">
                      <Select value={fromBranch} onChange={(e) => setFromBranch(e.target.value)}>
                        {/* Empty = the repo's current HEAD when it isn't a named ref. */}
                        {selected?.currentBranch && !branches.includes(selected.currentBranch) ? (
                          <option value="">{selected.currentBranch} (current)</option>
                        ) : null}
                        {branches.map((b) => (
                          <option key={b} value={b}>
                            {b}
                            {b === selected?.currentBranch ? ' (current)' : ''}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}
                  {agent !== 'none' ? (
                    <Field label="Initial prompt (optional)">
                      <Textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={3}
                        placeholder="Leave empty to just start the agent — attach later from a terminal or SSH."
                      />
                    </Field>
                  ) : null}
                </>
              ) : null}
            </div>
            {error ? <div className="font-mono text-xs text-destructive">{error}</div> : null}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        {jobId || bakeJobId ? (
          <>
            {jobStatus === 'streaming' ? (
              <span className="mr-auto self-center font-mono text-xs text-muted-foreground">
                {jobId
                  ? 'The box + agent start in the background — you can close this.'
                  : // The bake→create chain lives in this modal; closing it would
                    // finish the bake server-side but never fire the create.
                    'Keep this open — the box is created when the build finishes.'}
              </span>
            ) : null}
            <Button onClick={onClose}>Close</Button>
          </>
        ) : staleChoice ? (
          // Cloud stale base: the CLI wizard's rebuild-vs-use-existing choice.
          <>
            <span
              className="mr-auto self-center font-mono text-xs text-muted-foreground"
              title={providerFreshness?.baseStaleReason}
            >
              The {providerOption?.label ?? providerId} base image is out of date.
            </span>
            <Button variant="outline" onClick={() => setStaleChoice(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setStaleChoice(false);
                startCreate();
              }}
              disabled={pending}
            >
              Use existing image
            </Button>
            <Button
              onClick={() => {
                setStaleChoice(false);
                startBake();
              }}
              disabled={pending}
            >
              Rebuild &amp; create
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !projectId}>
              {pending ? 'Starting…' : 'Create box'}
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}

// The build-job state, shown as a status pill in the modal header. `badge-create`
// pulses (working); `badge-run` is the settled green (done); `badge-err` is red.
// A terminal job status always wins; only while the job is still running does a
// pending Claude re-login take over the pill (amber "Login required"), since the
// create is blocked on it.
function JobStatusBadge({ status, loginPhase }: { status: string; loginPhase?: JobLoginState['phase'] | null }) {
  if (status === 'done') {
    return (
      <Badge className="badge-run">
        <span className="badge-dot" />
        Done
      </Badge>
    );
  }
  if (status === 'failed' || status === 'error' || status === 'cancelled') {
    return (
      <Badge className="badge-err">
        <span className="badge-dot" />
        Failed
      </Badge>
    );
  }
  // A failed re-login is terminal for the create too — show red immediately rather
  // than "Working…" during the brief window before the job status flips to failed.
  if (loginPhase === 'error') {
    return (
      <Badge className="badge-err">
        <span className="badge-dot" />
        Login failed
      </Badge>
    );
  }
  if (loginPhase === 'awaiting-code' || loginPhase === 'starting' || loginPhase === 'exchanging') {
    return (
      <Badge className="badge-create">
        <span className="badge-dot" />
        Login required
      </Badge>
    );
  }
  return (
    <Badge className="badge-create">
      <span className="badge-dot" />
      Working…
    </Badge>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-secondary-foreground">{label}</span>
      {children}
    </label>
  );
}
