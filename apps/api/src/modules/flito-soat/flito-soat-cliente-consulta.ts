// FLITO — SOAT, canal Cliente: las DOS modalidades de consulta al RUNT (Feature #14012, HU #14017).
// Diseño: docs/diseno-feature-14012-soat-tipo-inicial-renovacion.md §0, §5 · ADR-0030.
//
//   · Inicial    → por VIN (HU #12090). Sin documento del propietario hacia el RUNT.
//   · Renovación → por placa + número de documento del propietario, SIN tipo de documento: el
//                  servidor lo resuelve (vía directa: `tiposVehiculoAIntentar`; NIT incluido).
//
// Este archivo es PURO (sin BD ni red) para que `flito-soat-cliente-runt.ts` y el servicio lo
// importen sin ciclos.

import { CodigoErrorSolicitudSoat } from '@operaciones/shared-types';

/** Valor de `flito_soat_solicitud.tipo_soat`. */
export type TipoSoatCanal = 'inicial' | 'renovacion';

/** Qué se le pregunta al RUNT. El documento de la renovación ES el del propietario (un solo campo). */
export type ConsultaRunt =
  | { modalidad: 'vin'; vin: string }
  | { modalidad: 'placa'; placa: string; documento: string };

/** Un `string` es la consulta por VIN de siempre (compatibilidad con los llamadores de Inicial). */
export type EntradaConsultaRunt = string | ConsultaRunt;

export function comoConsulta(entrada: EntradaConsultaRunt): ConsultaRunt {
  return typeof entrada === 'string' ? { modalidad: 'vin', vin: entrada } : entrada;
}

/**
 * ¿El RUNT dice que el vehículo NO tiene SOAT anterior? La ÚNICA definición (diseño §5):
 *
 *   · `true`  ⇔ `data.soat` es un arreglo VACÍO.
 *   · `false` ⇔ arreglo no vacío, u objeto con al menos una clave (se tolera el objeto suelto).
 *   · `null`  ⇔ INDETERMINADO: ausente, `null`, `{}` u otro tipo.
 *
 * **El indeterminado NO es «sin SOAT»** y el llamador lo trata como RUNT caído: la vía directa solo
 * añade `data.soat` si la sub-llamada no falló, así que «campo ausente» no distingue «no tiene» de
 * «no pude preguntar». NO se ha podido verificar con datos reales de Kyverum cómo llega «sin SOAT»
 * (R0-b del diseño); esta es la regla segura. Precio declarado: si Kyverum OMITE `soat` cuando no
 * hay póliza, esas renovaciones se leerán como RUNT no disponible (503), no como «sin SOAT».
 */
export function sinSoatAnterior(data: unknown): boolean | null {
  const soat = (data as { soat?: unknown } | null | undefined)?.soat;
  if (Array.isArray(soat)) return soat.length === 0;
  if (soat !== null && typeof soat === 'object') return Object.keys(soat).length > 0 ? false : null;
  return null;
}

export const MENSAJE_SIN_SOAT_ANTERIOR = 'Este vehículo no registra SOAT anterior: solicite un SOAT inicial';

export const CODIGO_SIN_SOAT_ANTERIOR = CodigoErrorSolicitudSoat.SOAT_SIN_ANTERIOR;

type CodigoReviseClave = 'runt_no_cuadra' | 'runt_sin_registro' | 'runt_sin_vin';

const SIN_VIN =
  'El RUNT no publica el VIN de este vehículo, y sin VIN no podemos radicar la solicitud. Escríbenos para revisarlo.';

/**
 * Mensajes «revise los datos» por modalidad. Ninguno dice qué valor tiene el RUNT (AC5): explican
 * qué revisar, no qué sabe el registro.
 */
export const MENSAJE_REVISE_POR_MODALIDAD: Record<ConsultaRunt['modalidad'], Record<CodigoReviseClave, string>> = {
  vin: {
    runt_no_cuadra: 'El RUNT no confirma este vehículo. Revisa el VIN que escribiste.',
    runt_sin_registro: 'El RUNT no tiene registrado un vehículo con ese VIN. Revísalo.',
    runt_sin_vin: SIN_VIN,
  },
  placa: {
    runt_no_cuadra: 'El RUNT no confirma este vehículo con esos datos. Revise la placa y el documento del propietario.',
    runt_sin_registro: 'El RUNT no tiene registrado un vehículo con esos datos. Revise la placa y el documento del propietario.',
    runt_sin_vin: SIN_VIN,
  },
};
