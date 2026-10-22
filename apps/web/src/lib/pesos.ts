// FLITO — El formato de pesos colombianos de las consolas: `es-CO`, sin decimales, «—» para null.
// Nació en `components/flito/ImpuestoCola.tsx` y se movió aquí cuando la consola logística lo
// necesitó (HU #12620): un solo `pesos` para la cola de impuestos y los viajes adicionales.
// ImpuestoCola lo re-exporta para no tocar a quien ya lo importaba de allí.

export const pesos = (v: number | string | null) => v === null ? '—'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(v));
