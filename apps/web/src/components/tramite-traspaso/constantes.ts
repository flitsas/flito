// Constantes del asistente de traspaso (HU 13988: extraídas de pages/TramiteTraspaso.tsx).

import type { CSSProperties } from 'react';
import type { ChipTone } from '../flit/StatusChip';
import { flitInp } from '../flit/flitPageKit';
import type { Parte } from './tipos';

export const PARTE_VACIA: Parte = { nombre: '', documento: '', tipoDoc: 'CC', direccion: '', telefono: '', email: '', ciudad: '' };
export const PASOS = ['Vehículo', 'Validación legal', 'Vendedor', 'Comprador', 'Comercial', 'Documentos'];
export const WIZARD_VERSION = '2026-06-10-cierre';
export const ESTADO_TONE: Record<string, ChipTone> = {
  radicado: 'active', en_validacion: 'active', subsanacion: 'warning', en_tramite: 'active',
  aprobado: 'success', rechazado: 'danger', entregado: 'success', anulado: 'neutral',
};
// Campo del kit (`.control`): borde 1 px, radio 9, foco azul + sombra kit, inválido naranja.
export const inputCls = `mt-1 ${flitInp}`;
// Tarjeta del kit: superficie elevada, borde 1 px de línea, radio 9, sin sombra.
export const cardStyle: CSSProperties = { borderRadius: 9, border: '1px solid var(--color-border)', background: 'var(--color-surface-elevated)' };
