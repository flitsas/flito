import { useEffect, useRef, useState } from 'react';

interface Options {
  /** Duración total en ms. */
  duration?: number;
  /** Valor inicial (0 por default). */
  from?: number;
  /** Easing function (default: easeOutExpo cinematográfico). */
  easing?: (t: number) => number;
  /** Si false, retorna inmediatamente el valor final (respeta prefers-reduced-motion). */
  enabled?: boolean;
}

const DEFAULT_EASING = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * useCountUp — anima un número de `from` → `target` con easing cinematográfico.
 * Respeta `prefers-reduced-motion` automáticamente (salta animación si está activo).
 *
 * Uso típico (KPI Dashboard):
 *   const value = useCountUp(soat?.totalVehicles ?? 0, { duration: 1200 });
 *   return <p className="tabular-nums">{value}</p>
 */
export function useCountUp(target: number | null | undefined, opts: Options = {}): number {
  const {
    duration = 900,
    from = 0,
    easing = DEFAULT_EASING,
    enabled = true,
  } = opts;
  const [value, setValue] = useState<number>(from);
  const startRef = useRef<number | null>(null);
  const fromRef = useRef<number>(from);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target == null) return;
    const reduce = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!enabled || reduce) {
      setValue(target);
      return;
    }
    fromRef.current = value;
    startRef.current = null;

    const tick = (ts: number) => {
      if (startRef.current == null) startRef.current = ts;
      const t = Math.min(1, (ts - startRef.current) / duration);
      const eased = easing(t);
      setValue(Math.round(fromRef.current + (target - fromRef.current) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration, enabled]);

  return value;
}
