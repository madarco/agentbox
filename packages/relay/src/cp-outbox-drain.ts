/**
 * Landing copies that were parked while this machine was offline.
 *
 * Runs on the user's machine when its relay first reaches the control box.
 * Every item still goes through a confirm: the copy is being applied to this
 * disk *now*, whatever a box asked for hours ago, and "I approved it earlier"
 * is not something the user ever actually did — a parked copy was never
 * approved by anyone, only accepted for transport.
 */

import { rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { askPrompt, type PendingPrompts, type PromptSubscribers } from './prompts.js';
import { boxWorkspacePath, lookupCloudBoxOwner } from './host-actions.js';
import { landCpOutboxTar, stageOutboxTar, type CpOutboxItem } from './cp-outbox.js';
import { describeCacheAge } from './cp-cache.js';
import { resolveHostPath } from '@agentbox/core';

export interface CpOutboxDrainDeps {
  controlPlaneUrl: string;
  adminToken: string;
  prompts: PendingPrompts;
  subscribers: PromptSubscribers;
  log: (line: string) => void;
}

const REQUEST_TIMEOUT_MS = 300_000;

/** Fetch, confirm and land every parked copy this machine can account for. */
export async function drainCpOutbox(deps: CpOutboxDrainDeps): Promise<void> {
  const base = deps.controlPlaneUrl.replace(/\/+$/, '');
  const listed = await getJson(`${base}/admin/hostreach/outbox`, deps.adminToken);
  const items = Array.isArray((listed as { items?: CpOutboxItem[] }).items)
    ? (listed as { items: CpOutboxItem[] }).items
    : [];
  if (items.length === 0) return;
  deps.log(`host-reach: ${String(items.length)} parked cop(y|ies) waiting for this machine`);

  for (const item of items) {
    // Only land for boxes this machine actually knows: another machine's parked
    // copy must stay parked for it, not be intercepted here.
    const owner = await lookupCloudBoxOwner(item.meta.boxId);
    if (!owner) continue;
    const workspacePath = await boxWorkspacePath(item.meta.boxId);
    const destAbs = resolveHostPath(workspacePath, item.meta.dest);
    const verdict = await askPrompt(deps.prompts, deps.subscribers, item.meta.boxId, {
      kind: 'confirm',
      message: `Land a copy ${owner.name} sent while this machine was offline?`,
      detail: [
        `${item.meta.sources.join(', ')} -> ${destAbs}`,
        `${describeCacheAge(item.meta.createdAt)}, ${String(item.meta.size)} bytes`,
      ].join('\n'),
      defaultAnswer: 'n',
      context: { command: 'cp.toHost (parked)', argv: [...item.meta.sources, destAbs] },
    });
    if (verdict.answer !== 'y') {
      deps.log(`host-reach: declined the parked copy from ${owner.name}; leaving it on the hub`);
      continue;
    }
    let stagedDir: string | undefined;
    try {
      const stream = await getStream(`${base}/admin/custody-blob/${item.tarPath}`, deps.adminToken);
      const staged = await stageOutboxTar(stream);
      stagedDir = staged.dir;
      // Destination semantics live in landCpOutboxTar, which follows `cp`: a
      // trailing slash or an existing directory receives the members, anything
      // else NAMES the file and a single member is renamed onto it.
      await landCpOutboxTar(staged.tarPath, destAbs, {
        destEndsWithSlash: /[/\\]$/.test(item.meta.dest),
      });
      await del(`${base}/admin/hostreach/outbox/${item.meta.id}`, deps.adminToken);
      deps.log(`host-reach: landed a parked copy from ${owner.name} at ${destAbs}`);
    } catch (err) {
      // Left on the hub deliberately: a failure here must not consume the only
      // copy of an agent's output.
      deps.log(
        `host-reach: could not land the parked copy from ${owner.name} (left on the hub): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (stagedDir) await rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function getJson(url: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        host: target.hostname,
        port: target.port.length > 0 ? Number.parseInt(target.port, 10) : isHttps ? 443 : 80,
        method: 'GET',
        path: target.pathname,
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`${target.pathname} → ${String(status)}`));
            return;
          }
          try {
            resolve(text.length > 0 ? JSON.parse(text) : {});
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`${target.pathname} timed out`));
    });
    req.end();
  });
}

function getStream(url: string, token: string): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        host: target.hostname,
        port: target.port.length > 0 ? Number.parseInt(target.port, 10) : isHttps ? 443 : 80,
        method: 'GET',
        path: target.pathname,
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`custody blob GET → ${String(status)}`));
          return;
        }
        resolve(res);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('custody blob GET timed out'));
    });
    req.end();
  });
}

function del(url: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        host: target.hostname,
        port: target.port.length > 0 ? Number.parseInt(target.port, 10) : isHttps ? 443 : 80,
        method: 'DELETE',
        path: target.pathname,
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`outbox DELETE → ${String(status)}`));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('outbox DELETE timed out'));
    });
    req.end();
  });
}
