'use client';

import { Ago } from '@/components/ago';
import { Icons, LangDot } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/boxes/store';
import { SectionLabel } from '../boxes/components/section-label';

export default function SettingsPage() {
  const { state } = useStore();
  const gh = state.github;

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">Settings</h1>
      <div className="mt-1.5 text-sm text-muted-foreground">GitHub access &amp; hub configuration.</div>

      <SectionLabel>GitHub App</SectionLabel>
      {!gh.available ? (
        <Card className="overflow-hidden">
          <div className="flex items-center gap-4 p-5">
            <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-secondary text-muted-foreground">
              <Icons.github className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[14.5px] font-semibold">
                GitHub App
                <Badge className="gap-1.5 normal-case">not available</Badge>
              </div>
              <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                The GitHub App leases repo-scoped tokens to cloud boxes from the hosted hub. On a local machine boxes
                use your own git credentials directly, so there is nothing to configure here.
              </div>
            </div>
          </div>
          <Separator />
          <div className="flex items-start gap-3 p-4 px-5 text-[12.5px] text-muted-foreground">
            <Icons.shield className="mt-0.5 size-[15px] flex-none text-primary" />
            <span>Available when the hub runs in a hosted profile (hetzner or vercel).</span>
          </div>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="flex items-center gap-4 p-5">
              <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-foreground text-background">
                <Icons.github className="size-6" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[14.5px] font-semibold">
                  {gh.appName}
                  {gh.installed ? (
                    <Badge className="badge-run gap-1.5 normal-case">
                      <span className="badge-dot" />
                      installed
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-0.5 font-mono text-[12.5px] text-muted-foreground">
                  {gh.installed ? `@${gh.account}` : 'Not installed'}
                </div>
              </div>
            </div>
          </Card>

          <SectionLabel right={<span className="font-mono text-[11px] tracking-normal text-[#a4a9b0]">{gh.repos.length} repos</span>}>
            Authorized repositories
          </SectionLabel>
          <Card className="divide-y divide-border/60 overflow-hidden">
            {gh.repos.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-md border border-border bg-background text-secondary-foreground">
                  <Icons.repo className="size-[15px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[13px] font-medium">{r.full}</span>
                  <span className="mt-0.5 flex items-center gap-3 font-mono text-[11.5px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <LangDot lang={r.lang} />
                      {r.lang}
                    </span>
                    <span>
                      updated <Ago ms={r.pushedAt} />
                    </span>
                    <Badge className={cn('px-1.5 py-0 text-[10px] uppercase tracking-[.03em]', r.private ? '' : 'border-[var(--green-line)] text-primary')}>
                      {r.private ? 'private' : 'public'}
                    </Badge>
                  </span>
                </span>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
