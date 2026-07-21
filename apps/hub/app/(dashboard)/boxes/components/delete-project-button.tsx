'use client';

import { useRouter } from 'next/navigation';
import { useTransition, type MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { removeProjectAction } from '@/lib/boxes/actions';
import type { Project } from '@/lib/boxes/types';

// Destructive: unregister an EMPTY project (zero boxes). Callers render this only
// when the project has no boxes; the backend enforces the same. Matches the box
// "Destroy" affordance — native confirm → action → refresh (no modal).
export function DeleteProjectButton({
  project,
  size,
  className,
  redirectHome,
}: {
  project: Project;
  size?: 'sm';
  className?: string;
  // Detail page: on success there's no project to return to, so go back to /.
  redirectHome?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const ok = window.confirm(
      `Remove project "${project.name}" from the hub? Its folder and files are NOT deleted — ` +
        `this only unregisters it (and any hub-set project settings). This cannot be undone.`,
    );
    if (!ok) return;
    startTransition(async () => {
      const res = await removeProjectAction(project.id);
      if (!res.ok) {
        window.alert(`Delete failed: ${res.error}`);
        return;
      }
      if (redirectHome) router.push('/');
      else router.refresh();
    });
  };

  return (
    <Button variant="destructive" size={size} className={className} title="Delete project" disabled={pending} onClick={onClick}>
      <Icons.trash />
      Delete
    </Button>
  );
}
