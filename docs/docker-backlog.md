# Docker / remote-docker provider backlog

Open items for the two docker-shaped providers (`packages/sandbox-docker`,
`packages/sandbox-remote-docker`). Each entry: what, why, and the constraint that
shapes it.

## `box.dockerRunArgs` + `--docker-arg` (user-supplied `docker run` flags)

**What.** A way to add flags to the box's own `docker run` for the cases the built-in
set can't predict: `--shm-size`, `--sysctl`, `--ulimit`, an extra `--device` or
capability. Two surfaces:

- `box.dockerRunArgs: string[]` as a **global-config-only** key
  (`~/.agentbox/config.yaml`), shown by `agentbox config get box.dockerRunArgs`.
- A repeatable `--docker-arg <flag>` on `create` / `claude` / the other create-shaped
  commands, for one-off boxes.

The args go after agentbox's own flags (`runBox` in `packages/sandbox-docker/src/docker.ts`,
`buildRunArgv` in `packages/sandbox-remote-docker/src/backend.ts`) and before the image,
so the built-in caps can't be dropped by accident. Both providers must honour it.
Docs call it "you own the consequences", like `box.persistent`.

**Not from project config or `agentbox.yaml`.** A cloned repo controls those files.
Honouring the key there would let any repo add `--privileged` or `-v /:/host` to
the box and escape the sandbox at create time. The project layer and
`agentbox.yaml` must ignore it (warn if set). Only a per-repo trust prompt could
lift this, the same shape as the `carry` approval: show the exact flags, remember
the answer per repo and per flag-set hash, and ask again when they change.

**Plumbing.** Creates run in the hub worker, which ignores project config for some
jobs. The resolved list has to ride the create request (`/api/v1`) instead of being
read hub-side, or a remote hub would apply its own config to a laptop's box.

**Origin.** Issue #396 asked for this next to the `SYS_PTRACE` fix. The fix shipped
without it, since the default now covers that case. This stays the escape hatch for
everything else.
