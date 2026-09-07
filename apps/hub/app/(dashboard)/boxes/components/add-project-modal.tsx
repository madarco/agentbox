'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';
import type { ReactNode } from 'react';
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
import { addProjectAction, browseDirAction, createProjectAction } from '@/lib/boxes/actions';
import type { DirEntry } from '@/lib/boxes/backend-types';
import { PROJECT_NAME_RE } from '@/app/(dashboard)/api/v1/lib/validate';

// Button + modal to register a folder on this machine as a project, so a box can
// be created in it even before it has any box — or to create a brand-new empty
// folder first, for a project that has no workspace yet (hosting a service bot).
export function AddProjectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Icons.plus />
        New project
      </Button>
      {open ? <AddProjectModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type Mode = 'existing' | 'create';

function AddProjectModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>('existing');
  // `path` is the folder the picker is currently showing — what gets added in
  // 'existing' mode, and the PARENT of the new folder in 'create' mode.
  const [path, setPath] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [git, setGit] = useState(false);

  // Load a directory into the picker. `dir` undefined = the host's home dir.
  const browse = useCallback(async (dir?: string) => {
    setLoading(true);
    setError(null);
    const res = await browseDirAction(dir);
    if (!res.ok) {
      setError(res.error);
      setLoading(false);
      return;
    }
    setPath(res.path);
    setParent(res.parent);
    setEntries(res.entries);
    setLoading(false);
  }, []);

  useEffect(() => {
    void browse();
  }, [browse]);

  const trimmedName = name.trim();
  const nameValid = PROJECT_NAME_RE.test(trimmedName);

  const submit = () => {
    setError(null);
    const p = path.trim();
    if (!p) {
      setError('choose a folder');
      return;
    }
    if (mode === 'create' && !nameValid) {
      setError('name must be a single folder name (letters, digits, . _ -; no leading dot)');
      return;
    }
    startTransition(async () => {
      const res =
        mode === 'existing'
          ? await addProjectAction(p)
          : await createProjectAction({ parent: p, name: trimmedName, git });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog onClose={onClose}>
      <DialogHeader>
        <DialogIcon>
          <Icons.folder />
        </DialogIcon>
        <div>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            {mode === 'existing'
              ? 'Pick a folder on this machine'
              : 'Pick where to create the new folder'}
          </DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-2.5">
        <div className="flex gap-1.5" role="tablist" aria-label="Project source">
          <ModeButton active={mode === 'existing'} onClick={() => setMode('existing')}>
            Existing folder
          </ModeButton>
          <ModeButton active={mode === 'create'} onClick={() => setMode('create')}>
            Create new
          </ModeButton>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="flex-none px-2.5"
            onClick={() => void browse(parent ?? undefined)}
            disabled={!parent || loading}
            title="Up one level"
            aria-label="Up one level"
          >
            <Icons.arrowUp />
          </Button>
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/Projects/my-app"
            className="font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void browse(path);
            }}
          />
        </div>

        <div className="h-56 overflow-y-auto rounded-lg border border-border bg-background">
          {loading ? (
            <div className="px-3 py-2.5 font-mono text-xs text-muted-foreground">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
              No subfolders here
            </div>
          ) : (
            entries.map((e) => (
              <button
                key={e.path}
                type="button"
                onClick={() => void browse(e.path)}
                className="flex w-full cursor-pointer items-center gap-2 border-0 border-b border-border/60 bg-transparent px-3 py-2 text-left text-[13px] transition-colors last:border-b-0 hover:bg-secondary"
              >
                <Icons.folder className="size-4 flex-none text-muted-foreground" />
                <span className="truncate">{e.name}</span>
                {e.isProject ? (
                  <span className="ml-auto flex-none rounded border border-[var(--green-line)] bg-accent px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-primary">
                    project
                  </span>
                ) : (
                  <Icons.chevR className="ml-auto size-3.5 flex-none text-[#a4a9b0]" />
                )}
              </button>
            ))
          )}
        </div>

        {mode === 'create' ? (
          <>
            <Field label="Folder name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-bot"
                className="font-mono text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
              />
            </Field>
            <p
              className="truncate font-mono text-xs text-muted-foreground"
              title={`${path}/${trimmedName}`}
            >
              {trimmedName
                ? `${path.replace(/\/$/, '')}/${trimmedName}`
                : 'The folder is created empty.'}
            </p>
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={git}
                onChange={(e) => setGit(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-none accent-primary"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-secondary-foreground">
                  Initialize a git repository
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  git init on main, a .gitignore for .agentbox/, and an initial commit.
                </span>
              </span>
            </label>
          </>
        ) : null}

        {error ? <div className="font-mono text-xs text-destructive">{error}</div> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={pending || loading || (mode === 'create' && !nameValid)}>
          {mode === 'existing'
            ? pending
              ? 'Adding…'
              : 'Add this folder'
            : pending
              ? 'Creating…'
              : 'Create project'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={active ? 'default' : 'outline'}
      role="tab"
      aria-selected={active}
      onClick={onClick}
    >
      {children}
    </Button>
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
