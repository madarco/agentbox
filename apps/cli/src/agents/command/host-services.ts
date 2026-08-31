/**
 * The app side of {@link AgentHostServices} — the capabilities an agent's hooks
 * ask for but cannot import.
 *
 * Everything here lives in `apps/cli`: the setup wizard, base-image freshness,
 * `runPrepare`, host clipboard capture, plan staging. An agent package sits
 * below `apps/cli` in the dependency graph, so it reaches these through the
 * contract rather than by importing them — which is what let claude's descriptor
 * move into `@agentbox/agent-claude` instead of staying behind in this folder.
 */

import type {
  AgentClipboardServices,
  AgentHostServices,
  AgentPlanFileRequest,
  AgentSetupWizardOutcome,
  AgentSetupWizardRequest,
  CreateRouting,
  ResolvedTeleport,
} from '@agentbox/cli-kit';
import { log } from '@agentbox/cli-kit';
import type { EffectiveConfig } from '@agentbox/config';
import type { BoxRecord } from '@agentbox/core';
import { evaluateBaseFreshness } from '../../checkpoint-lookup.js';
import { clipboardCaptureAvailable } from '../../lib/host-clipboard.js';
import { maybeShowInstallHint } from '../../lib/install-hint.js';
import { pasteHostClipboardImage, uploadImageFileToBox } from '../../lib/paste-image.js';
import { providerForBox } from '../../provider/registry.js';
import { runPrepare } from '../../commands/prepare.js';
import { resolvePlanTeleport } from '../../session-teleport/plan.js';
import { maybeRunSetupWizard } from '../../wizard.js';

export interface HostServicesInit {
  workspace: string;
  providerName: string;
  cfg: EffectiveConfig;
  yes: boolean;
  /** Resolved lazily by the caller and memoised — see `AgentCreateContext.routing`. */
  routing(): Promise<CreateRouting>;
  /** Read at call time: the body may still be resolving it when the bag is built. */
  checkpointRef(): string | undefined;
  /** Whether the preflight forced a local build, so a hub route is off the table. */
  hubIncompatible(): boolean;
}

export const hostClipboard: AgentClipboardServices = {
  available: () => clipboardCaptureAvailable(),
  async pasteImage(box: BoxRecord) {
    return pasteHostClipboardImage(await providerForBox(box), box);
  },
  async pasteImageFile(box: BoxRecord, hostPath: string) {
    return uploadImageFileToBox(await providerForBox(box), box, hostPath);
  },
};

export function makeHostServices(init: HostServicesInit): AgentHostServices {
  return {
    clipboard: hostClipboard,
    showInstallHint: () => maybeShowInstallHint(),

    resolvePlanFile(req: AgentPlanFileRequest): Promise<ResolvedTeleport> {
      return resolvePlanTeleport({
        planPath: req.path,
        hostCwd: req.hostCwd,
        log: req.log,
        boxParentDir: req.boxParentDir,
      });
    },

    async setupWizard(req: AgentSetupWizardRequest): Promise<AgentSetupWizardOutcome> {
      // Graded against the ROUTE, not just the provider: a hub-routed create is
      // built on the control box from ITS base, so this machine's base is
      // irrelevant. Asking to spend minutes re-baking locally — for a box that
      // never touches the result — is pure waste, and it is exactly what a PC
      // sees whenever the control box has re-baked and the PC hasn't.
      const buildsOnHub = (await init.routing()).where === 'hub' && !init.hubIncompatible();
      const baseStatus = buildsOnHub
        ? undefined
        : await evaluateBaseFreshness(init.providerName, init.cfg.box.claudeInstall);

      const wiz = await maybeRunSetupWizard({
        workspace: init.workspace,
        yes: init.yes,
        command: 'agent',
        checkpointRef: init.checkpointRef(),
        checkpointFromDefault: req.checkpointFromDefault,
        provider: init.providerName,
        withEnv: init.cfg.box.withEnv,
        baseStatus,
      });

      // Stale base and the user opted in: re-bake the snapshot/template and
      // refresh its stored fingerprint so the box boots from the fresh base.
      // BEFORE the checkpoint decision reaches the caller, so a failed bake
      // aborts cleanly rather than leaving a half-created box.
      if (wiz.rebuildBase) {
        log.warn(`${init.providerName} base image is outdated; rebuilding before create…`);
        await runPrepare(init.providerName, {
          force: true,
          cwd: init.workspace,
          suppressStatus: true,
        });
      }

      return {
        action: wiz.action,
        ...(wiz.initialPrompt !== undefined ? { initialPrompt: wiz.initialPrompt } : {}),
        ...(wiz.envFilesToImport !== undefined ? { envFilesToImport: wiz.envFilesToImport } : {}),
        ...(wiz.discardCheckpoint !== undefined
          ? { discardCheckpoint: wiz.discardCheckpoint }
          : {}),
      };
    },
  };
}
