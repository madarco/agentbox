'use client';

// `git.identity.*`: the committer identity this hub gives a box built with no
// PC behind it (a web-UI or tray create). A CLI create sends its own.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Identity {
  name: string;
  email: string;
}

const ENDPOINT = '/api/v1/settings/git-identity';

async function errorOf(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `HTTP ${String(r.status)}`;
}

export function GitIdentityCard() {
  const [saved, setSaved] = useState<Identity | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = (identity: Identity | null) => {
    setSaved(identity);
    setName(identity?.name ?? '');
    setEmail(identity?.email ?? '');
  };

  useEffect(() => {
    let alive = true;
    fetch(ENDPOINT, { credentials: 'same-origin' })
      .then(async (r) => (r.ok ? ((await r.json()) as { identity: Identity | null }) : null))
      .then((j) => {
        if (alive && j) apply(j.identity);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const save = async (identity: Identity | null) => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(ENDPOINT, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identity }),
      });
      if (!r.ok) {
        setError(await errorOf(r));
        return;
      }
      apply(((await r.json()) as { identity: Identity | null }).identity);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const loading = saved === undefined;
  const dirty = name.trim() !== (saved?.name ?? '') || email.trim() !== (saved?.email ?? '');

  return (
    <Card className="overflow-hidden p-5">
      <div className="text-[14.5px] font-semibold">Commit identity for new boxes</div>
      <div className="mt-0.5 text-[12.5px] text-muted-foreground">
        Used by boxes created here or from the tray. A box created from the CLI commits as that
        project&apos;s own git user instead. Existing boxes keep the identity they were created
        with.
      </div>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ name: name.trim(), email: email.trim() });
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="git-identity-name">Name</Label>
          <Input
            id="git-identity-name"
            value={name}
            disabled={loading || saving}
            placeholder="Ada Lovelace"
            maxLength={256}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="git-identity-email">Email</Label>
          <Input
            id="git-identity-email"
            type="email"
            value={email}
            disabled={loading || saving}
            placeholder="ada@example.com"
            maxLength={256}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button
            type="submit"
            size="sm"
            disabled={loading || saving || !dirty || !name.trim() || !email.trim()}
          >
            Save
          </Button>
          {saved ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => void save(null)}
            >
              Clear
            </Button>
          ) : null}
          {!loading && !saved ? (
            <span className="text-[12.5px] text-muted-foreground">
              Not set: such boxes use this machine&apos;s git config, else a generic agentbox
              identity.
            </span>
          ) : null}
        </div>
      </form>
      {error ? <div className="mt-3 text-[12.5px] text-destructive">{error}</div> : null}
    </Card>
  );
}
