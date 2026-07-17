// TRAM-ARCH-01 — constantes FLIT compartidas por pasos del wizard.

export const FLIT_CARD = 'bg-white rounded-[18px] border border-[color:var(--flit-border-soft)] shadow-[0_8px_24px_rgba(22,39,68,0.08)] p-6';
export const FLIT_PRIMARY = 'flit-focus inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-[999px] text-sm font-semibold text-white';
export const FLIT_STEP_TITLE = 'text-lg font-bold mb-1';
export const FLIT_STEP_TITLE_STYLE = { color: 'var(--flit-blue-text)' } as const;
export const FLIT_STEP_SUB = 'text-sm mb-5';
export const FLIT_STEP_SUB_STYLE = { color: 'var(--flit-text-muted)' } as const;
export const FLIT_INPUT = 'flit-focus w-full px-3 py-2.5 rounded-[10px] text-sm border border-[color:var(--flit-border-input)] bg-white text-[color:var(--flit-text-primary)] outline-none transition-shadow';

// Estilos de tarjeta de resultado OK/error (verde / rojo) — usados en pasos con
// validación (documentos OCR, identidad).
export const FLIT_OK = { border: '1px solid rgba(112,207,58,0.30)', background: 'rgba(112,207,58,0.10)' } as const;
export const FLIT_ERR = { border: '1px solid rgba(228,61,48,0.30)', background: 'rgba(228,61,48,0.10)' } as const;
export const FLIT_INFO = { border: '1px solid rgba(79,116,201,0.30)', background: 'rgba(79,116,201,0.08)' } as const;
