import type { Box } from '@/lib/boxes/types';

// Truthful placeholder — real agent output streaming lands in a later phase.
export function AgentTerminal({ box }: { box: Box }) {
  const live = box.status === 'running';
  const message = live
    ? 'Agent is running — live output streaming arrives in a later update.'
    : box.status === 'paused'
      ? 'Box is paused — resume to stream agent output.'
      : `Box is ${box.status}. Live CLI streaming arrives when the box is running.`;

  return (
    <div className="term">
      <div className="term-bar">
        <span className="td r" />
        <span className="td y" />
        <span className="td g" />
        <span className="term-title">
          {box.agent} — {box.id}
        </span>
        {live ? (
          <span className="term-state">
            <span className="ld" />
            streaming
          </span>
        ) : null}
      </div>
      <div className="term-body grid min-h-[150px] place-items-center">
        <div className="text-center">
          <span className="inline-block rounded-full border border-[#2c313a] px-3 py-1 text-[11px] uppercase tracking-[.1em] text-[#828893]">
            {live ? 'Streaming soon' : 'Output unavailable'}
          </span>
          <div className="mt-3 text-[11.5px] text-[#5b616b]">{message}</div>
        </div>
      </div>
    </div>
  );
}
