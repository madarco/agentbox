# Security Policy

## Supported versions

AgentBox is pre-1.0 and moves fast. Only the latest published release of
[`@madarco/agentbox`](https://www.npmjs.com/package/@madarco/agentbox) receives security fixes.
Please upgrade before reporting.

## Reporting a vulnerability

**Do not open a public issue.**

Report privately through GitHub Security Advisories:
[Report a vulnerability](https://github.com/madarco/agentbox/security/advisories/new).

Please include what an attacker can do, the steps to reproduce it, the AgentBox version, and the
provider you were running (`docker`, `daytona`, `hetzner`, `vercel`, `e2b`, ...).

You can expect an initial response within a few days. Once a fix ships, you'll be credited in the
advisory unless you'd rather not be.

## Scope notes

AgentBox runs coding agents inside sandboxes so that they cannot touch the host. Things that are
in scope, roughly:

- A box escaping its isolation and reaching host files, credentials, or processes it should not.
- Host credentials (SSH keys, git tokens, cloud API keys) leaking into a box or into a cloud
  provider when they should have stayed on the host.
- The host relay or the Control Hub performing a host action without the approval gate that is
  supposed to guard it, or accepting a request without a valid per-box token.
- Anything that lets one box read or control another box.

Out of scope: what an agent does with the access you deliberately gave it inside its own box, and
vulnerabilities in the upstream cloud providers themselves (report those to the provider).
