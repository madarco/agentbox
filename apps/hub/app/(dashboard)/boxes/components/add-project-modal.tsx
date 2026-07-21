'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';
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
import { addProjectAction, browseDirAction } from '@/lib/boxes/actions';
import type { DirEntry } from '@/lib/boxes/backend-types';

// Button + modal to register a folder on this machine as a project, so a box can
// be created in it even before it has any box.
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

function AddProjectModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // `path` is the folder the picker is currently showing — also what gets added.
  const [path, setPath] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const submit = () => {
    setError(null);
    const p = path.trim();
    if (!p) {
      setError('choose a folder');
      return;
    }
    startTransition(async () => {
      const res = await addProjectAction(p);
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
          <DialogDescription>Pick a folder on this machine</DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-2.5">
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
            <div className="px-3 py-2.5 font-mono text-xs text-muted-foreground">No subfolders here</div>
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

        {error ? <div className="font-mono text-xs text-destructive">{error}</div> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={pending || loading}>
          {pending ? 'Adding…' : 'Add this folder'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
