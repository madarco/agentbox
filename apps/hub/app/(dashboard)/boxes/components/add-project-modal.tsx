'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
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
import { addProjectAction } from '@/lib/boxes/actions';

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
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const p = path.trim();
    if (!p) {
      setError('enter an absolute folder path');
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
          <DialogDescription>Register a folder on this machine</DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-secondary-foreground">Absolute path</span>
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/Projects/my-app"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        </label>
        {error ? <div className="font-mono text-xs text-destructive">{error}</div> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={pending}>
          {pending ? 'Adding…' : 'Add project'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
