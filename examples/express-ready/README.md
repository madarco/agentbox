# express-ready — pre-wired smoke fixture

Same trivial Express server as `examples/express-server`, but ships with a hand-crafted `agentbox.yaml` so it can be created non-interactively. Used by the Portless smoke test on the Hetzner provider **and** the `carry:` smoke (host→box file copy).

## Portless smoke

```bash
cd examples/express-ready
cp .env.example .env
node ../../apps/cli/dist/index.js create --provider hetzner -y -n smoke
# After ready:
curl http://smoke.localhost:1355   # via host portless proxy
```

`expose.port: 3000` routes the supervisor's WebProxy (`:80` inside the box) to the Express server. The Hetzner provider also runs a `portless` mirror inside the VPS so `http://smoke.localhost:1355` resolves to the same content from the in-box browser.

## `carry:` smoke

The yaml's `carry:` block copies `~/.agentbox/carry-smoke/marker.txt` from the host into `~/carried-marker.txt` inside the box (mode 0600, owner vscode). A `verify-carry` task asserts the file landed correctly — any failure shows up as a failed task in `agentbox status`.

```bash
# 1. Stage a non-sensitive marker file the carry: block points at
mkdir -p ~/.agentbox/carry-smoke
echo "carry-smoke-$(date +%s)" > ~/.agentbox/carry-smoke/marker.txt

# 2. Docker
node ../../apps/cli/dist/index.js create -w . --provider docker -y -n carry-docker --carry-yes
node ../../apps/cli/dist/index.js shell carry-docker -- stat -c '%a %U:%G %n' /home/vscode/carried-marker.txt
# expect: 600 vscode:vscode /home/vscode/carried-marker.txt

# 3. Hetzner (slow — provisions a real VPS; needs `agentbox hetzner login`
#    + `agentbox prepare --provider hetzner` once on a fresh host)
node ../../apps/cli/dist/index.js create -w . --provider hetzner -y -n carry-hz --carry-yes
node ../../apps/cli/dist/index.js shell carry-hz -- stat -c '%a %U:%G %n' /home/vscode/carried-marker.txt
node ../../apps/cli/dist/index.js status carry-hz   # verify-carry shows succeeded

# 4. Cleanup
node ../../apps/cli/dist/index.js destroy carry-docker carry-hz -y
rm -rf ~/.agentbox/carry-smoke
```

Negative paths: `AGENTBOX_CARRY=skip … create` should create the box but `carried-marker.txt` shouldn't exist (and `verify-carry` should fail loud). Non-TTY `-y` without `--carry-yes` should fail with a `AGENTBOX_CARRY_YES=1` hint and not provision anything.
