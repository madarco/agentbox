'use client';

// How this hub reaches GitHub (`GET /api/v1/settings/git-access`): the PC's own
// git and `gh` (local hub), a token copied to the control box at setup, or a
// GitHub App leasing 1-hour single-repo tokens. Read-only.
import { useEffect, useState, type ReactNode } from 'react';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import type { GitAccessView } from '@/lib/boxes/backend-types';

type GitAccess = GitAccessView;

const ENDPOINT = '/api/v1/settings/git-access';

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[12px] text-foreground">{children}</code>;
}

function Shell({
  title,
  badge,
  sub,
  body,
  foot,
  dark,
}: {
  title: ReactNode;
  badge?: ReactNode;
  sub?: ReactNode;
  body: ReactNode;
  foot?: ReactNode;
  dark?: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-4 p-5">
        <span
          className={
            dark
              ? 'grid h-11 w-11 flex-none place-items-center rounded-xl bg-foreground text-background'
              : 'grid h-11 w-11 flex-none place-items-center rounded-xl bg-secondary text-muted-foreground'
          }
        >
          <Icons.github className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[14.5px] font-semibold">
            {title}
            {badge}
          </div>
          {sub ? (
            <div className="mt-0.5 font-mono text-[12.5px] text-muted-foreground">{sub}</div>
          ) : null}
          <div className="mt-1.5 text-[12.5px] text-muted-foreground">{body}</div>
        </div>
      </div>
      {foot ? (
        <>
          <Separator />
          <div className="flex items-start gap-3 p-4 px-5 text-[12.5px] text-muted-foreground">
            <Icons.shield className="mt-0.5 size-[15px] flex-none text-primary" />
            <span>{foot}</span>
          </div>
        </>
      ) : null}
    </Card>
  );
}

const ROTATE = (
  <>
    To use a different token, run <Code>agentbox hub setup</Code> again on your PC: it deploys the
    hub again with a fresh copy. There is no command to swap the token in place yet.
  </>
);

function LocalCard({ v }: { v: GitAccess }) {
  return (
    <Shell
      title="This machine"
      badge={<Badge className="normal-case">local</Badge>}
      sub={v.login ? `gh: @${v.login}` : undefined}
      body={
        <>
          Boxes push through this machine, with your own git and <Code>gh</Code> login. Nothing to
          set up.
        </>
      }
      foot="Boxes hold no git credential. Each push or pull request waits for your approval, then runs here."
    />
  );
}

function TokenCard({ v }: { v: GitAccess }) {
  if (!v.tokenPresent) {
    return (
      <Shell
        title="GitHub token"
        badge={<Badge className="badge-err gap-1.5 normal-case">missing</Badge>}
        body={
          <>
            This hub has no GitHub token, so clones and pushes fail. Run{' '}
            <Code>agentbox hub setup</Code> on your PC to copy one from your <Code>gh</Code> login.
          </>
        }
      />
    );
  }
  const badge = v.tokenRejected ? (
    <Badge className="badge-err gap-1.5 normal-case">rejected</Badge>
  ) : v.login ? (
    <Badge className="badge-run gap-1.5 normal-case">
      <span className="badge-dot" />
      working
    </Badge>
  ) : null;
  return (
    <Shell
      dark
      title="GitHub token"
      badge={badge}
      sub={v.login ? `@${v.login} on ${v.host}` : v.host}
      body={
        v.tokenRejected ? (
          <>GitHub rejected the token copied from your PC at setup (401), so pushes fail.</>
        ) : v.login ? (
          <>
            Pushes as <Code>{v.login}</Code> with the GitHub token copied from your PC at setup.
            Boxes never see it.
          </>
        ) : (
          <>
            Pushes with the GitHub token copied from your PC at setup. Boxes never see it.
            {v.error ? <span className="block">Could not check the account: {v.error}</span> : null}
          </>
        )
      }
      foot={
        <>
          {v.app ? (
            <span className="block">
              A GitHub App (id {v.app.id}) is also set on this hub: new boxes are cloned through it,
              so it must be installed on their repositories.
            </span>
          ) : null}
          {ROTATE}
        </>
      }
    />
  );
}

function AppCard({ v }: { v: GitAccess }) {
  const app = v.app;
  if (!app) {
    return (
      <Shell
        title="GitHub App"
        badge={<Badge className="badge-err gap-1.5 normal-case">key missing</Badge>}
        body={
          <>
            This hub is set to push through a GitHub App (<Code>hub.gitAuth app</Code>), but it has
            no App key, so boxes cannot push.
          </>
        }
      />
    );
  }
  const name = app.name ?? app.slug ?? `GitHub App ${app.id}`;
  const installs = app.installations;
  return (
    <Shell
      dark
      title={
        app.url ? (
          <a href={app.url} target="_blank" rel="noreferrer" className="hover:underline">
            {name}
          </a>
        ) : (
          name
        )
      }
      badge={<Badge className="normal-case">GitHub App</Badge>}
      sub={app.owner ? `owned by @${app.owner}` : undefined}
      body={
        installs === undefined ? (
          v.error ? (
            <>Could not read the App from GitHub: {v.error}</>
          ) : (
            <>Could not read where the App is installed.</>
          )
        ) : installs.length === 0 ? (
          <>Not installed on any account yet, so boxes cannot push.</>
        ) : (
          <>
            Installed on{' '}
            {installs.map((i, n) => (
              <span key={i.account}>
                {n > 0 ? ', ' : ''}
                <Code>@{i.account}</Code> (
                {i.repositories === 'all' ? 'all repositories' : 'selected repositories'})
              </span>
            ))}
            .
          </>
        )
      }
      foot="Boxes get a 1-hour token for their one repository when they push. The App key stays on the hub."
    />
  );
}

export function GitAccessCard() {
  const [view, setView] = useState<GitAccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(ENDPOINT, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!alive) return;
        if (r.ok) {
          setView((await r.json()) as GitAccess);
          return;
        }
        const body = (await r.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `HTTP ${String(r.status)}`);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <Card className="p-5 text-[12.5px] text-destructive">
        Could not read the git access: {error}
      </Card>
    );
  }
  if (!view) {
    return <Card className="p-5 text-[12.5px] text-muted-foreground">Checking git access…</Card>;
  }
  if (view.mode === 'local') return <LocalCard v={view} />;
  if (view.mode === 'app') return <AppCard v={view} />;
  return <TokenCard v={view} />;
}
