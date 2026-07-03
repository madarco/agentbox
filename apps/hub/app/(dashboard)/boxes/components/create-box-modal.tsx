'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { Icons } from '@/components/icons';
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
import { createBoxAction } from '@/lib/boxes/actions';
import type { CreateBoxInput } from '@/lib/boxes/backend-types';
import type { Project } from '@/lib/boxes/types';
import { JobLogStream } from './job-log-stream';

type Agent = CreateBoxInput['agent'];

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
  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState(project?.id ?? projects[0]?.id ?? '');
  const [agent, setAgent] = useState<Agent>('claude');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const selected = projects.find((p) => p.id === projectId) ?? project;

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
        name: name.trim() || undefined,
        prompt: prompt.trim() || undefined,
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
    <Dialog onClose={onClose} className="max-w-[560px]">
      <DialogHeader>
        <DialogIcon>
          <Icons.box />
        </DialogIcon>
        <div>
          <DialogTitle>{jobId ? 'Creating box…' : 'Create box'}</DialogTitle>
          <DialogDescription>{selected ? selected.name : 'Start a box in a project'}</DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        {jobId ? (
          <JobLogStream jobId={jobId} onDone={() => router.refresh()} />
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
            <Field label="Agent">
              <Select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="opencode">OpenCode</option>
              </Select>
            </Field>
            <Field label="Name (optional)">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="auto" />
            </Field>
            <Field label="Initial prompt (optional)">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder="Leave empty to just start the agent — attach later from a terminal or SSH."
              />
            </Field>
            {error ? <div className="font-mono text-xs text-destructive">{error}</div> : null}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        {jobId ? (
          <Button onClick={onClose}>Close</Button>
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-secondary-foreground">{label}</span>
      {children}
    </label>
  );
}
