// HU #13310 (Feature #13309, Épica #12741, ADR-0021) — destino del envío del comprobante de pago del
// impuesto. El outbox `flito_impuesto_envios_flit2` (0219) sirve desde la 0221 a FLIT 2 y a FLIT 1 según
// la columna `destino`. Los valores deben coincidir con los CHECK `ck_flito_impuesto_envios_flit2_destino`
// y `ck_flito_impuesto_envios_flit2_flit1_estado` (test de paridad en apps/api).

import type { EnvioComprobanteFlit2, EstadoEnvioFlit2 } from './flito-envio-flit2.js';

export const DestinoEnvioComprobante = { FLIT1: 'flit1', FLIT2: 'flit2' } as const;
export type DestinoEnvioComprobante = typeof DestinoEnvioComprobante[keyof typeof DestinoEnvioComprobante];
export const DESTINOS_ENVIO_COMPROBANTE: readonly DestinoEnvioComprobante[] = Object.values(DestinoEnvioComprobante);

/** Estados que puede tomar una fila FLIT 1 (CHECK ck_flito_impuesto_envios_flit2_flit1_estado). */
export const ESTADOS_ENVIO_FLIT1: readonly EstadoEnvioFlit2[] = ['pendiente', 'enviado', 'error', 'sin_comprobante'];

/** AC10: el envío con su destino. Sin motivo del error (va a auditoría, como D-4 de FLIT 2). */
export interface EnvioComprobante extends EnvioComprobanteFlit2 { destino: DestinoEnvioComprobante }

/** Intentos contra FLIT 1 antes de dejar la fila en `error` (ADR-0021 D-1). Un intento = una pasada (1-3 pasos). */
export const MAX_INTENTOS_ENVIO_FLIT1 = 3;
