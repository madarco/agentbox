'use client';

/**
 * The bots this project holds a backup of, and a way into restoring one.
 *
 * This card LISTS; it does not carry its own restore form. The button opens the
 * ordinary New Box modal with Start-from already on that backup, so there is one
 * restore implementation reachable from wherever a restore is discovered — here,
 * or from the create button itself. A second modal would be a second set of
 * rules about which backups may be offered.
 *
 * Self-hides when the project has no bots, which is every project until someone
 * backs one up.
 *
 * A pure REST client: `fetch` against `/api/v1`, no server actions.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { Card } from '@/components/ui/card';
import type { Project } from '@/lib/boxes/types';
import { CreateBoxButton } from '../../../boxes/components/create-box-modal';
import {
  preferredBackup,
  readableStamp,
  restorableBackups,
  restoreKeyOf,
  type BotBackups,
} from '../../../boxes/components/bots';
import { SectionLabel } from '../../../boxes/components/section-label';

export function ProjectBots({ project }: { project: Project }) {
  const [bots, setBots] = useState<BotBackups[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/bots`, {
        credentials: 'same-origin',
      });
      if (!r.ok) {
        setBots([]);
        return;
      }
      const { bots: found } = (await r.json()) as { bots: BotBackups[] };
      setBots(found);
    } catch {
      setBots([]);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (bots.length === 0) return null;

  return (
    <>
      <SectionLabel>Bot backups</SectionLabel>
      <Card className="divide-y divide-border/60 overflow-hidden">
        {bots.map((b) => {
          const newest = preferredBackup(b) ?? b.backups[0];
          // A bundle with no state half restores a workspace and a FRESH
          // identity, which is what clone already does — the route refuses it, so
          // the button must not offer it either.
          const restorable = restorableBackups(b);
          return (
            <div key={b.bot} className="flex flex-wrap items-center gap-3 px-4.5 p-3.5">
              <div className="min-w-[180px] flex-1">
                <div className="font-mono text-[13.5px] font-medium">{b.bot}</div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {b.backups.length} backup{b.backups.length === 1 ? '' : 's'}
                  {newest ? ` · newest ${readableStamp(newest.stamp)}` : ''}
                  {restorable.length > 0 ? '' : ' · workspace only, no identity captured'}
                </div>
              </div>
              {restorable.length > 0 && newest ? (
                <CreateBoxButton
                  project={project}
                  variant="outline"
                  size="sm"
                  label="Restore…"
                  icon={Icons.refresh}
                  initialRestore={restoreKeyOf(b.bot, newest.stamp)}
                />
              ) : (
                <span
                  className="text-[11.5px] text-muted-foreground"
                  title="These backups captured no agent state, so there is no identity to restore."
                >
                  Not restorable
                </span>
              )}
            </div>
          );
        })}
      </Card>
    </>
  );
}
