---
name: agentbox-identity
description: Write this bot's identity replacement rules into agentbox.yaml, so a copy of it spawned with `agentbox clone` gets its own name instead of yours. Invoke once, after onboarding, when the workspace has no `identity` rule-set yet.
---

# /agentbox-identity

## Why you are doing this

Your workspace can be cloned. `agentbox clone <this-box> -n <new-name>` copies
these files into a second box and starts a second bot from them.

That second bot gets its own gateway identity and its own channel tokens
automatically. What it does **not** get automatically is a different *name*:
`SOUL.md` and `IDENTITY.md` are your own writing, and a verbatim copy would
introduce itself with your name, refer to itself in your words, and answer to
the same handle you do. Two bots, one identity, in every conversation the copy
takes part in.

You are the only one who knows which words in those files are *you* and which
are just words. So you write the rule, once, and AgentBox applies it to every
clone made afterwards.

## What you write

A named rule-set called `identity` in `/workspace/agentbox.yaml`. Each rule
replaces one literal that means "me" with `{{AGENTBOX_BOX_NAME}}`, which AgentBox
substitutes with the new box's name when it clones.

```yaml
# agentbox:identity-rules (written by /agentbox-identity — review, then keep)
replacements:
  identity:
    - from: '\bAda\b'
      to: '{{AGENTBOX_BOX_NAME}}'
      regex: true
```

## Steps

1. **Check you have not already done this.** If `/workspace/agentbox.yaml`
   contains `agentbox:identity-rules`, stop — the rules exist, and rewriting
   them would discard edits the user may have made. Say so and do nothing else.

2. **Read `/workspace/SOUL.md` and `/workspace/IDENTITY.md`** (either may be
   absent; use whichever exist).

3. **Collect the identity literals.** Include:
   - your name, as it appears in those files;
   - any handle or username the files present as yours (`@ada_bot`);
   - any other string that a copy of you must not inherit verbatim.

   Do **not** include:
   - the user's name, their company, their project — those belong to a clone as
     much as to you;
   - your role, personality, or preferences ("terse", "a research assistant") —
     a clone is meant to inherit those; they are what makes it a copy of *you*
     rather than a blank bot;
   - anything shorter than three characters, or a common word. A rule for a name
     like "Bo" or "Max" will rewrite unrelated text. If your name is a common
     word, keep the rule anyway but make it as specific as you can (match
     `Max the assistant`, not `Max`), and say in your reply that you did.

4. **Write the rule-set** into `/workspace/agentbox.yaml`:
   - Use `regex: true` with `\b` word boundaries around each literal, so `Ada`
     does not rewrite `Adafruit`. Escape any regex metacharacter in the literal
     itself.
   - Put the sentinel comment line immediately above `replacements:`.
   - If a `replacements:` block already exists, **add** the `identity` key to it
     rather than replacing the block — other rule-sets there belong to the user.
   - Change nothing else in the file. In particular do not touch `openclaw:`,
     `carry:`, `services:` or `tasks:`.

5. **Check your work.** Re-read the file and confirm it is still valid YAML and
   that only the rule-set (and the sentinel) was added. If the workspace has an
   `agentbox` CLI available, `agentbox-ctl validate` is the direct check.

6. **Tell the user, briefly**: which literals you covered, and that a clone will
   now introduce itself by its own box name. Mention any literal you deliberately
   skipped as too short or too common — that is a judgement they may want to
   overrule.

## What happens next

Nothing, for you: these rules never apply to your own files. They are read on the
host when someone clones this workspace, and applied to the copy on its way into
the new box. Your `SOUL.md` is untouched, now and on every reboot.
