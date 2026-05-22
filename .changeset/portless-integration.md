---
"@madarco/agentbox": minor
---

Portless integration: on Docker Desktop (which has no per-container DNS like
OrbStack's `.orb.local`), boxes can now get a stable `https://<box-name>.localhost`
URL for their web app via the [Portless](https://portless.sh) proxy.

- First-run opt-in prompt on Docker Desktop; the answer is saved to the new
  `portless.enabled` config key (also `--portless` / `--no-portless` flags). On
  "yes" it installs the `portless` CLI if missing and starts a proxy with
  `portless proxy start --no-tls -p 1355` — a high port with no TLS, so it
  needs no root password and no certificate-trust prompt. Box web apps are then
  served at `http://<box-name>.localhost:1355`. An already-running proxy (e.g. a
  `:443` HTTPS one) is left alone and used as-is.
- `create` registers `portless alias <box-name> <webHostPort>`; `start`
  re-points it after Docker reallocates the port; `destroy` removes it. The
  real URL is resolved via `portless get` and surfaced in `agentbox browser`,
  `list`, and `status`.
- The box image now ships the `portless` CLI (Node bumped 22 -> 24) and, when
  enabled, shares the host's Portless state directory so the in-box
  `portless list`/`get` can discover routes.
- `agentbox screen` opens the in-box browser (shown via VNC) on the same
  `<box-name>.localhost` URL the host uses — routed back out to the host proxy
  via a Chromium `--host-resolver-rules` mapping — so the web app is one origin
  whether viewed from the host or inside the box (simpler Next.js / OAuth / CORS
  config).

All Portless interaction is best-effort — an install/start/alias failure
degrades to a printed hint and never blocks box creation. Requires
`docker rmi agentbox/box:dev` to pick up the new image.
