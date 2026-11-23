'use client';

// A plain SKILL.md editor. Saving stores a new `upload` version through
// PUT /api/v1/skills/{name}/skill-md: the hub keeps the skill's other files,
// swaps SKILL.md, checks the frontmatter and the secret scan, and makes it
// current (running boxes that hold the skill sync). With no `skill`, it creates
// a new skill whose only file is SKILL.md.

import { useEffect, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { api, errText, short, type SkillMdRead, type SkillRow } from './api';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function template(name: string): string {
  const n = name || 'my-skill';
  return `---\nname: ${n}\ndescription: What this skill does and when the agent should use it.\n---\n\n# ${n}\n\n`;
}

/** Keep the frontmatter `name:` in step with the name field while creating. */
function withName(content: string, name: string): string {
  return content.replace(/^(---\r?\n(?:.*\r?\n)*?)name:.*$/m, `$1name: ${name}`);
}

export function EditorDialog({
  skill,
  onClose,
  onSaved,
}: {
  /** The skill to edit; absent = create a new one. */
  skill?: SkillRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const creating = !skill;
  const [name, setName] = useState(skill?.name ?? '');
  const [loaded, setLoaded] = useState<SkillMdRead | null>(null);
  const [content, setContent] = useState(creating ? template('') : '');
  const [error, setError] = useState<string | null>(null);
  const [findingsBlock, setFindingsBlock] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!skill) return;
    api<SkillMdRead>(`/skills/${encodeURIComponent(skill.name)}/skill-md`)
      .then((r) => {
        setLoaded(r);
        setContent(r.content);
      })
      .catch((err: unknown) => setError(errText(err)));
  }, [skill]);

  const save = async (allowFindings = false) => {
    setBusy(true);
    setError(null);
    setFindingsBlock(false);
    try {
      await api(`/skills/${encodeURIComponent(name)}/skill-md`, {
        method: 'PUT',
        body: JSON.stringify({
          content,
          ...(loaded ? { base: loaded.version } : {}),
          ...(allowFindings ? { allowFindings: true } : {}),
        }),
      });
      onSaved();
      onClose();
    } catch (err) {
      const msg = errText(err);
      setError(msg);
      setFindingsBlock(msg.startsWith('secret scan:'));
    } finally {
      setBusy(false);
    }
  };

  const origin = skill?.origin?.kind;
  const others = loaded?.files.filter((f) => f.path !== 'SKILL.md') ?? [];
  const nameOk = NAME_RE.test(name) && name !== 'agentbox' && !name.startsWith('agentbox-');
  const ready = creating ? nameOk : loaded !== null;

  return (
    <Dialog onClose={onClose} className="max-w-[820px]">
      <DialogHeader>
        <DialogIcon>
          <Icons.pencil />
        </DialogIcon>
        <div className="min-w-0">
          <DialogTitle>{creating ? 'New skill' : `Edit ${skill.name}`}</DialogTitle>
          <DialogDescription>
            {creating
              ? 'Saved to the library as an upload; every box with the default set gets it.'
              : loaded
                ? `SKILL.md at ${short(loaded.version)} · saving stores a new version`
                : 'Loading…'}
          </DialogDescription>
        </div>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        {creating ? (
          <div>
            <Label htmlFor="skill-new-name">Name</Label>
            <Input
              id="skill-new-name"
              value={name}
              onChange={(e) => {
                const n = e.target.value.toLowerCase();
                setName(n);
                setContent((c) => withName(c, n));
              }}
              placeholder="my-skill"
              className="font-mono text-xs"
            />
            {name && !nameOk ? (
              <div className="mt-1 font-mono text-[11px] text-red-400">
                lowercase letters, digits and hyphens; not agentbox or agentbox-*
              </div>
            ) : null}
          </div>
        ) : null}
        {origin && origin !== 'upload' ? (
          <div className="rounded-lg border border-[var(--amber-line)] bg-[var(--amber-soft)] px-3 py-2 text-xs">
            This skill comes from{' '}
            {origin === 'folder' ? 'a linked folder on a PC' : `a ${origin} source`}. Saving here
            makes it an upload:{' '}
            {origin === 'folder'
              ? 'the next save in that folder replaces this edit.'
              : 'a refresh no longer fetches it from upstream.'}
          </div>
        ) : null}
        <Textarea
          aria-label="SKILL.md"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="min-h-[380px] font-mono text-[12px] leading-[1.55]"
          disabled={!creating && !loaded}
        />
        {others.length > 0 ? (
          <div className="font-mono text-[11px] text-[#a4a9b0]">
            kept as they are: {others.map((f) => f.path).join(', ')}
          </div>
        ) : null}
        {error ? <div className="font-mono text-xs text-red-400">{error}</div> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {findingsBlock ? (
          <Button variant="destructive" disabled={busy} onClick={() => void save(true)}>
            Save anyway
          </Button>
        ) : null}
        <Button disabled={!ready || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : creating ? 'Create skill' : 'Save version'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
