// TRAM-ARCH-01 — constantes FLIT compartidas por pasos del wizard (piel del UI Kit 2026).

import { flitInp } from '../../../components/flit/flitPageKit';

export const FLIT_CARD = 'bg-[var(--color-surface-elevated)] rounded-[9px] border border-[color:var(--color-border)] p-6';
/** Botón primario del kit (`.btn`, píldora azul plana). */
export const FLIT_PRIMARY = 'btn';
export const FLIT_STEP_TITLE = 'text-lg font-bold mb-1';
export const FLIT_STEP_TITLE_STYLE = { color: 'var(--color-action)' } as const;
export const FLIT_STEP_SUB = 'text-sm mb-5';
export const FLIT_STEP_SUB_STYLE = { color: 'var(--color-text-tertiary)' } as const;
export const FLIT_INPUT = flitInp;

// Estilos de tarjeta de resultado OK/error (verde / rojo) — usados en pasos con
// validación (documentos OCR, identidad).
export const FLIT_OK = { border: '1px solid color-mix(in srgb, var(--kit-verde) 30%, transparent)', background: 'color-mix(in srgb, var(--kit-verde) 10%, transparent)' } as const;
export const FLIT_ERR = { border: '1px solid color-mix(in srgb, var(--kit-rojo) 30%, transparent)', background: 'color-mix(in srgb, var(--kit-rojo) 10%, transparent)' } as const;
export const FLIT_INFO = { border: '1px solid color-mix(in srgb, var(--kit-azul) 30%, transparent)', background: 'color-mix(in srgb, var(--kit-azul) 8%, transparent)' } as const;

/** Chip del kit en estado activo (borde azul, fondo hover, texto azul) cuando el botón no lleva `aria-pressed`. */
export const CHIP_ACTIVO = { borderColor: 'var(--color-action)', background: 'var(--kit-hover)', color: 'var(--color-action)' } as const;
