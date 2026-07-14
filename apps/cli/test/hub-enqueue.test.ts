import { describe, expect, it } from 'vitest';
import { enqueueCreateViaHub, getHubJob, pollHubJob } from '../src/control-plane/hub-enqueue.js';
import type { CreateJobRow } from '@agentbox/relay/control-plane';

// Pure — a fake fetch, no network, no HOME (apps/cli tests share the real HOME).

const target = { url: 'https://hub.example/', adminToken: 'admin-secret' };

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('enqueueCreateViaHub', () => {
  it('POSTs the create request with the admin bearer and returns the job id', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(jsonRes(202, { jobId: 'job-1' }));
    }) as unknown as typeof fetch;
    const id = await enqueueCreateViaHub(
      { ...target, fetchImpl },
      { repoUrl: 'https://x/r.git', provider: 'e2b', branch: 'main' },
    );
    expect(id).toBe('job-1');
    expect(seen?.url).toBe('https://hub.example/remote/boxes');
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe('Bearer admin-secret');
    expect(JSON.parse(seen?.init.body as string)).toMatchObject({ provider: 'e2b', branch: 'main' });
  });

  it('throws on a non-202 response', async () => {
    const fetchImpl = (() => Promise.resolve(jsonRes(401, { error: 'invalid admin token' }))) as unknown as typeof fetch;
    await expect(enqueueCreateViaHub({ ...target, fetchImpl }, { repoUrl: 'x', provider: 'e2b' })).rejects.toThrow(/401/);
  });
});

describe('getHubJob', () => {
  it('returns null on 404', async () => {
    const fetchImpl = (() => Promise.resolve(jsonRes(404, { error: 'no such job' }))) as unknown as typeof fetch;
    expect(await getHubJob({ ...target, fetchImpl }, 'missing')).toBeNull();
  });
});

describe('pollHubJob', () => {
  it('polls until done, reporting each status transition', async () => {
    const states: CreateJobRow['status'][] = ['queued', 'running', 'done'];
    let i = 0;
    const fetchImpl = (() => {
      const status = states[Math.min(i++, states.length - 1)]!;
      const row: CreateJobRow = {
        id: 'job-1',
        status,
        request: { repoUrl: 'x', provider: 'e2b' },
        createdAt: '2026-01-01T00:00:00Z',
        ...(status === 'done' ? { result: { boxId: 'box-9' } } : {}),
      };
      return Promise.resolve(jsonRes(200, row));
    }) as unknown as typeof fetch;
    const seen: string[] = [];
    const job = await pollHubJob({ ...target, fetchImpl }, 'job-1', {
      sleep: () => Promise.resolve(),
      onStatus: (j) => seen.push(j.status),
    });
    expect(job.result?.boxId).toBe('box-9');
    expect(seen).toEqual(['queued', 'running', 'done']);
  });

  it('times out if the job never finishes', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonRes(200, { id: 'j', status: 'running', request: { repoUrl: 'x', provider: 'e2b' }, createdAt: 'x' }),
      )) as unknown as typeof fetch;
    let clock = 0;
    await expect(
      pollHubJob({ ...target, fetchImpl }, 'j', {
        sleep: () => Promise.resolve(),
        now: () => (clock += 60_000),
        timeoutMs: 120_000,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
