'use client';

// Add skills from a source the HUB fetches: a git repository or a plugin in a
// marketplace repository. Two steps over POST /api/v1/skills: a `dryRun` lists
// what the source holds (with each skill's scan findings and problems), then
// the import of the ones picked.

import { useState } from 'react';
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
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { fmtBytes } from '@/lib/boxes/format';
import { cn } from '@/lib/utils';
import { api, errText, type AddResult, type SkillCandidate, type SkillPolicy } from './api';

type Kind = 'git' | 'marketplace';

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-md border px-2.5 py-1 text-xs',
        active
          ? 'border-[var(--green-line)] bg-[var(--green-soft)] text-primary'
          : 'border-border bg-card text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Candidate({
  c,
  picked,
  onToggle,
}: {
  c: SkillCandidate;
  picked: boolean;
  onToggle: () => void;
}) {
  const blocked = c.problems.length > 0;
  return (
    <label
      className={cn(
        'flex items-start gap-3 px-3 py-2.5',
        blocked ? 'opacity-60' : 'cursor-pointer',
      )}
    >
      <input
        type="checkbox"
        className="mt-1"
        checked={picked}
        disabled={blocked}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[13px]">{c.name}</div>
        <div className="line-clamp-2 text-xs text-muted-foreground">{c.description}</div>
        <div className="mt-0.5 font-mono text-[11px] text-[var(--faint)]">
          {c.path || '.'} · {fmtBytes(c.size)} · {c.files} file{c.files === 1 ? '' : 's'}
        </div>
        {c.problems.map((p, i) => (
          <div key={i} className="mt-0.5 font-mono text-[11px] text-red-400">
            {p}
          </div>
        ))}
        {c.findings.length > 0 ? (
          <div className="mt-0.5 font-mono text-[11px] text-[var(--amber)]">
            secret scan:{' '}
            {c.findings.map((f) => `${f.rule} in ${f.path}:${String(f.line)}`).join(', ')}
          </div>
        ) : null}
      </div>
    </label>
  );
}

export function AddSourceDialog({
  initial,
  onClose,
  onAdded,
}: {
  initial: Kind;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<Kind>(initial);
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [path, setPath] = useState('');
  const [plugin, setPlugin] = useState('');
  const [policy, setPolicy] = useState<SkillPolicy>('manual');
  const [allowFindings, setAllowFindings] = useState(false);
  const [found, setFound] = useState<AddResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<AddResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = () =>
    kind === 'git'
      ? {
          git: {
            url: url.trim(),
            ...(ref.trim() ? { ref: ref.trim() } : {}),
            ...(path.trim() ? { path: path.trim() } : {}),
          },
        }
      : {
          marketplace: {
            url: url.trim(),
            plugin: plugin.trim(),
            ...(ref.trim() ? { ref: ref.trim() } : {}),
          },
        };

  const reset = () => {
    setFound(null);
    setResult(null);
    setError(null);
  };

  const lookUp = async () => {
    setBusy(true);
    reset();
    try {
      const r = await api<AddResult>('/skills', {
        method: 'POST',
        body: JSON.stringify({ ...source(), dryRun: true }),
      });
      setFound(r);
      setPicked(
        new Set(
          r.candidates
            .filter((c) => c.problems.length === 0 && c.findings.length === 0)
            .map((c) => c.name),
        ),
      );
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<AddResult>('/skills', {
        method: 'POST',
        body: JSON.stringify({
          ...source(),
          skills: [...picked],
          policy,
          ...(allowFindings ? { allowFindings: true } : {}),
        }),
      });
      setResult(r);
      if (r.imported.length > 0) onAdded();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const pickedFindings =
    found?.candidates.some((c) => picked.has(c.name) && c.findings.length > 0) ?? false;
  const canLookUp = url.trim().length > 0 && (kind === 'git' || plugin.trim().length > 0);

  return (
    <Dialog onClose={onClose} className="max-w-[620px]">
      <DialogHeader>
        <DialogIcon>
          <Icons.repo />
        </DialogIcon>
        <div>
          <DialogTitle>Add skills</DialogTitle>
          <DialogDescription>
            The hub fetches the source and keeps the commit it read.
          </DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <div className="flex gap-1.5" role="tablist" aria-label="Source">
          <Tab
            active={kind === 'git'}
            onClick={() => {
              setKind('git');
              reset();
            }}
          >
            Git repository
          </Tab>
          <Tab
            active={kind === 'marketplace'}
            onClick={() => {
              setKind('marketplace');
              reset();
            }}
          >
            Marketplace plugin
          </Tab>
        </div>
        <div>
          <Label htmlFor="skill-src-url">
            {kind === 'git' ? 'Repository' : 'Marketplace repository'}
          </Label>
          <Input
            id="skill-src-url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              reset();
            }}
            placeholder={
              kind === 'git'
                ? 'https://github.com/owner/repo or owner/repo'
                : 'https://github.com/owner/marketplace'
            }
            className="font-mono text-xs"
          />
        </div>
        <div className="flex gap-2.5 max-sm:flex-col">
          {kind === 'git' ? (
            <div className="flex-1">
              <Label htmlFor="skill-src-path">Path (optional)</Label>
              <Input
                id="skill-src-path"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  reset();
                }}
                placeholder="skills/my-skill"
                className="font-mono text-xs"
              />
            </div>
          ) : (
            <div className="flex-1">
              <Label htmlFor="skill-src-plugin">Plugin</Label>
              <Input
                id="skill-src-plugin"
                value={plugin}
                onChange={(e) => {
                  setPlugin(e.target.value);
                  reset();
                }}
                placeholder="plugin-name"
                className="font-mono text-xs"
              />
            </div>
          )}
          <div className="w-40 max-sm:w-full">
            <Label htmlFor="skill-src-ref">Ref (optional)</Label>
            <Input
              id="skill-src-ref"
              value={ref}
              onChange={(e) => {
                setRef(e.target.value);
                reset();
              }}
              placeholder="main"
              className="font-mono text-xs"
            />
          </div>
        </div>

        {found ? (
          <>
            <div className="font-mono text-[11px] uppercase tracking-[.1em] text-[var(--faint)]">
              {found.candidates.length} skill{found.candidates.length === 1 ? '' : 's'} at{' '}
              {found.commit.slice(0, 12)}
            </div>
            <div className="max-h-64 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
              {found.candidates.map((c) => (
                <Candidate
                  key={c.name}
                  c={c}
                  picked={picked.has(c.name)}
                  onToggle={() =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (n.has(c.name)) n.delete(c.name);
                      else n.add(c.name);
                      return n;
                    })
                  }
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-1.5">
                Updates
                <Select
                  value={policy}
                  onChange={(e) => setPolicy(e.target.value as SkillPolicy)}
                  size="sm"
                  className="bg-card"
                >
                  <option value="manual">wait for approval</option>
                  <option value="auto">apply automatically</option>
                </Select>
              </label>
              {pickedFindings ? (
                <label className="flex items-center gap-1.5 text-[var(--amber)]">
                  <input
                    type="checkbox"
                    checked={allowFindings}
                    onChange={(e) => setAllowFindings(e.target.checked)}
                  />
                  I read the scan findings; add anyway
                </label>
              ) : null}
            </div>
          </>
        ) : null}

        {result ? (
          <div className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs">
            {result.imported.map((i) => (
              <div key={i.name} className="text-[var(--green-ink)]">
                added {i.name} ({i.version.slice(0, 12)})
              </div>
            ))}
            {result.skipped.map((s) => (
              <div key={s.name} className="text-[var(--amber)]">
                skipped {s.name}: {s.reason}
              </div>
            ))}
          </div>
        ) : null}
        {error ? <div className="font-mono text-xs text-red-400">{error}</div> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {result ? 'Done' : 'Cancel'}
        </Button>
        {!found || result ? (
          <Button disabled={!canLookUp || busy} onClick={() => void lookUp()}>
            {busy ? 'Fetching…' : found ? 'Look up again' : 'Look up'}
          </Button>
        ) : (
          <Button
            disabled={picked.size === 0 || busy || (pickedFindings && !allowFindings)}
            onClick={() => void add()}
          >
            {busy ? 'Adding…' : `Add ${String(picked.size)} skill${picked.size === 1 ? '' : 's'}`}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
