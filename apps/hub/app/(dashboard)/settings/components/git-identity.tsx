'use client';

// `git.identity.*`: the committer identity this hub gives a box built with no
// PC behind it (a web-UI or tray create). A CLI create sends its own. The card
// shows the current value; editing happens in a dialog.
import { useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    // A failed read still unlocks the editor (as unset) and says why, rather than
    // leaving it greyed out with no explanation.
    fetch(ENDPOINT, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!alive) return;
        if (r.ok) {
          setSaved(((await r.json()) as { identity: Identity | null }).identity);
          return;
        }
        setSaved(null);
        setError(`Could not read the current identity: ${await errorOf(r)}`);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setSaved(null);
        setError(
          `Could not read the current identity: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    return () => {
      alive = false;
    };
  }, []);

  /** True once the hub stored it. */
  const save = async (identity: Identity | null): Promise<boolean> => {
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
        return false;
      }
      setSaved(((await r.json()) as { identity: Identity | null }).identity);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const loading = saved === undefined;

  return (
    <Card className="overflow-hidden p-5">
      <div className="flex items-start gap-4 max-sm:flex-col">
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold">Commit identity for new boxes</div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">
            Used by boxes created here or from the tray. A box created from the CLI commits as that
            project&apos;s own git user instead. Existing boxes keep the identity they were created
            with.
          </div>
          <div className="mt-3 text-[13px]">
            {loading ? (
              <span className="text-muted-foreground">Loading…</span>
            ) : saved ? (
              <span className="font-mono">
                {saved.name} &lt;{saved.email}&gt;
              </span>
            ) : (
              <span className="text-[12.5px] text-muted-foreground">
                Not set: such boxes use this machine&apos;s git config, else a generic agentbox
                identity.
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading || saving}
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
          >
            <Icons.pencil /> {saved ? 'Edit identity' : 'Set identity'}
          </Button>
        </div>
      </div>
      {error && !editing ? (
        <div className="mt-3 text-[12.5px] text-destructive">{error}</div>
      ) : null}
      {editing ? (
        <IdentityDialog
          initial={saved ?? null}
          saving={saving}
          error={error}
          onClose={() => {
            setEditing(false);
            setError(null);
          }}
          onSave={async (identity) => {
            if (await save(identity)) setEditing(false);
          }}
        />
      ) : null}
    </Card>
  );
}

function IdentityDialog({
  initial,
  saving,
  error,
  onClose,
  onSave,
}: {
  initial: Identity | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (identity: Identity) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const dirty = name.trim() !== (initial?.name ?? '') || email.trim() !== (initial?.email ?? '');

  return (
    <Dialog onClose={saving ? () => {} : onClose}>
      <DialogHeader>
        <DialogIcon>
          <Icons.commit />
        </DialogIcon>
        <div>
          <DialogTitle>Commit identity for new boxes</DialogTitle>
          <DialogDescription>git.identity.name / git.identity.email</DialogDescription>
        </div>
      </DialogHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({ name: name.trim(), email: email.trim() });
        }}
      >
        <DialogBody className="grid gap-4">
          <div>
            <Label htmlFor="git-identity-name">Name</Label>
            <Input
              id="git-identity-name"
              value={name}
              disabled={saving}
              placeholder="Ada Lovelace"
              maxLength={256}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="git-identity-email">Email</Label>
            <Input
              id="git-identity-email"
              type="email"
              value={email}
              disabled={saving}
              placeholder="ada@example.com"
              maxLength={256}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error ? <div className="text-[12.5px] text-destructive">{error}</div> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={saving || !dirty || !name.trim() || !email.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
