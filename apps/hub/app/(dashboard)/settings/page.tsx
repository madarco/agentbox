'use client';

import { useEffect, useState } from 'react';
import { SectionLabel } from '../boxes/components/section-label';
import { GitAccessCard } from './components/git-access';
import { GitIdentityCard } from './components/git-identity';
import { LimitPolicyCard } from './components/limit-policy';
import { ProvidersSection } from './components/provider-actions';

export default function SettingsPage() {
  const [version, setVersion] = useState<string | null>(null);

  // Pure REST: read the running hub's version off the public health probe.
  useEffect(() => {
    let alive = true;
    fetch('/api/v1/health', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { version?: string } | null) => {
        if (alive && j?.version) setVersion(j.version);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-8 max-sm:px-4">
      <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.025em]">General</h1>
      <div className="mt-1.5 text-sm text-muted-foreground">
        Providers, git access &amp; hub configuration.
      </div>

      <SectionLabel
        right={
          <span className="font-mono text-[11px] tracking-normal text-[var(--faint)]">
            credentials &amp; base images
          </span>
        }
      >
        Sandbox providers
      </SectionLabel>
      <ProvidersSection />

      <SectionLabel>Subscriptions</SectionLabel>
      <LimitPolicyCard />

      <SectionLabel>Git</SectionLabel>
      <div className="grid gap-3">
        <GitAccessCard />
        <GitIdentityCard />
      </div>

      <div className="mt-10 text-center font-mono text-[11px] text-muted-foreground">
        AgentBox {version ?? '…'}
      </div>
    </div>
  );
}
