// Constantes del asistente de traspaso (HU #13988: extraídas de pages/TramiteTraspaso.tsx).

import type { CSSProperties } from 'react';
import type { ChipTone } from '../flit/StatusChip';
import type { Parte } from './tipos';

export const PARTE_VACIA: Parte = { nombre: '', documento: '', tipoDoc: 'CC', direccion: '', telefono: '', email: '', ciudad: '' };
export const PASOS = ['Vehículo', 'Validación legal', 'Vendedor', 'Comprador', 'Comercial', 'Documentos'];
export const WIZARD_VERSION = '2026-06-10-cierre';
export const ESTADO_TONE: Record<string, ChipTone> = {
  radicado: 'active', en_validacion: 'active', subsanacion: 'warning', en_tramite: 'active',
  aprobado: 'success', rechazado: 'danger', entregado: 'success', anulado: 'neutral',
};
export const inputCls = 'flit-focus mt-1 w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm text-[color:var(--flit-text-primary)] outline-none';
export const cardStyle: CSSProperties = { borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' };
