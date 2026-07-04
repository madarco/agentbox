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

  const selected = projects.find((p) => p.id === projectId) ?? project;

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
    <Dialog onClose={onClose} className={jobId ? 'max-w-[900px]' : 'max-w-[560px]'}>
      <DialogHeader>
        <DialogIcon>
          <Icons.box />
        </DialogIcon>
        <div>
          <DialogTitle>Create box</DialogTitle>
          <DialogDescription>{selected ? selected.name : 'Start a box in a project'}</DialogDescription>
        </div>
        {/* Live job state next to the close button: pulsating while working, a pill when settled. */}
        {jobId ? (
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
        {jobId ? (
          <>
            {jobStatus === 'streaming' ? (
              <span className="mr-auto self-center font-mono text-xs text-muted-foreground">
                The box + agent start in the background — you can close this.
              </span>
            ) : null}
            <Button onClick={onClose}>Close</Button>
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
