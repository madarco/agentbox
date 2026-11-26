import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MouseEvent as ReactMouseEvent, ReactElement, ReactNode, RefObject } from 'react';

// useLayoutEffect warns during server rendering; the measured values only matter in a browser.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The element's content width, tracked with a ResizeObserver. `fallback` until mounted. */
export function useWidth<T extends HTMLElement | SVGSVGElement>(
  fallback = 640,
): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

type Tip = { content: ReactNode; x: number; y: number } | null;
type TipApi = {
  show: (content: ReactNode, ev: ReactMouseEvent) => void;
  hide: () => void;
};

const TipContext = createContext<TipApi>({ show: () => undefined, hide: () => undefined });

export const useTip = (): TipApi => useContext(TipContext);

/** One floating tooltip for the whole page, like the mockup's. */
export function TipProvider({ children }: { children: ReactNode }): ReactElement {
  const [tip, setTip] = useState<Tip>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const show = useCallback((content: ReactNode, ev: ReactMouseEvent) => {
    setTip({ content, x: ev.clientX, y: ev.clientY });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const api = useMemo(() => ({ show, hide }), [show, hide]);
  useIsoLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    let left = tip.x + 14;
    let top = tip.y + 14;
    if (left + r.width > window.innerWidth - 8) left = tip.x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = tip.y - r.height - 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [tip]);
  return (
    <TipContext.Provider value={api}>
      {children}
      <div
        ref={ref}
        className={`tip${tip && pos ? ' on' : ''}`}
        style={pos ? { left: pos.left, top: pos.top } : undefined}
        role="tooltip"
      >
        {tip?.content}
      </div>
    </TipContext.Provider>
  );
}

export function TipRow({
  color,
  label,
  value,
}: {
  color: string;
  label: ReactNode;
  value: ReactNode;
}): ReactElement {
  return (
    <div className="r">
      <i style={{ background: color }} />
      {label}
      <b>{value}</b>
    </div>
  );
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Counts up to `value` once on mount; renders the final value on the server. */
export function CountUp({
  value,
  format,
}: {
  value: number;
  format: (n: number) => string;
}): ReactElement {
  const [shown, setShown] = useState(value);
  // Where the next count starts: 0 on first mount, then the last value shown.
  const from = useRef(0);
  // A layout effect, so a client render drops to the start before the first paint
  // instead of flashing the final number.
  useIsoLayoutEffect(() => {
    if (prefersReducedMotion()) {
      setShown(value);
      from.current = value;
      return;
    }
    const start = from.current;
    setShown(start);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number): void => {
      const p = Math.min(1, (t - t0) / 1100);
      const cur = start + (value - start) * (1 - Math.pow(1 - p, 3));
      from.current = cur;
      setShown(cur);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(shown)}</>;
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
  small,
  label,
}: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  small?: boolean;
  label: string;
}): ReactElement {
  return (
    <div className={`seg${small ? ' small' : ''}`} role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          className={v === value ? 'on' : undefined}
          aria-pressed={v === value}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
