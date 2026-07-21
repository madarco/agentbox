/**
 * The public registry the box image is published to, and how a build-context
 * fingerprint names an image in it.
 *
 * These are pure string helpers, but they live here rather than in
 * `@agentbox/sandbox-docker` (which owns the pull/build machinery) because two
 * unrelated providers need the *ref* without wanting the machinery:
 *
 *   - docker pulls this ref instead of building locally when the fingerprint
 *     matches a published build (`pullOrBuild`).
 *   - daytona's linux-vm bake *must* have it: Daytona can only build a VM
 *     snapshot from a prebuilt registry image, never from a Dockerfile.
 *
 * `sandbox-docker/src/image.ts` imports `execa` at module scope, so importing
 * the ref from there would drag a process-spawning dependency into the daytona
 * import graph for two lines of string concatenation.
 */

/**
 * Public registry repo the box image is published to (see
 * `.github/workflows/box-image.yml`). An empty registry (config override)
 * disables pulling and always builds.
 */
export const BOX_IMAGE_REGISTRY = 'ghcr.io/madarco/agentbox/box';

/**
 * The pull target for a given build-context fingerprint. The tag *is* the
 * content identity: a local staged context that matches a published build has
 * the same sha, so a pull hit can be retagged to `agentbox/box:dev` without
 * risk of a stale image (a locally edited context has a different sha, its tag
 * 404s, and we build instead).
 */
export function registryRefForSha(sha: string, registry: string = BOX_IMAGE_REGISTRY): string {
  return `${registry}:sha-${sha.slice(0, 16)}`;
}
