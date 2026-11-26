// FLITO SOAT — vigencia del SOAT y guards de estado que salieron de `flito-soat.service.ts` (Épica #14707, ADR-0049 §4).
//
// `flito-soat.service.ts` está en su techo congelado de líneas (eslint.config.mjs): cada guard nuevo de la Épica es
// UNA línea allí que reemplaza una comprobación existente, y la lógica vive aquí. Se mudan también `SoatError`, el
// validador de motivo y `noAdmiteTraspaso` (HU #11153), que el servicio re-exporta/usa igual que antes.
//
//   · La vigencia de un SOAT es su ESTADO, no la de un trámite: un SOAT compartido sobrevive a la muerte de uno de sus
//     trámites (D3b). `descartado` (su trámite murió en FLIT) → 409 `TRAMITE_NO_VIGENTE` en toda acción de avance.
//   · Red de seguridad: el trigger FL409 de la 0318 impide salir de `descartado` aunque una acción olvide el guard.
//   · Este archivo NO importa `flito-soat.service.ts` (sin ciclos).
import { EstadoSoat, ESTADO_SOAT_LABEL, type MotivoDescarte } from '@operaciones/shared-types';
import { exigirRegistroVigente } from '../../shared/tramite-vigente.js';

export class SoatError extends Error {
  constructor(public status: number, message: string, public codigo?: string) { super(message); }
}

/** Épica #14707: un SOAT `descartado` no admite acciones de avance (409 TRAMITE_NO_VIGENTE, vía `errorHandler`). */
export function exigirSoatVigente(soat: { estado: string; motivoDescarte?: MotivoDescarte | null }): void {
  exigirRegistroVigente('soat', soat);
}

/**
 * Estados en los que el traspaso tiene sentido: el registro ya salió a gestión y todavía no se
 * pagó. `pendiente` no ha salido —para eso está el destino del envío (HU #11152)— y `pagado` ya
 * consumió el dinero, así que cambiarle el gestor no describe nada real.
 */
export const ESTADOS_TRASPASO_GESTION: readonly EstadoSoat[] = [EstadoSoat.SOLICITADO, EstadoSoat.CON_NOVEDAD];

const MOTIVO_MINIMO = 5;

/** Mensaje según por qué el estado no admite traspaso: el usuario necesita saber cuál de los tres es. */
export function noAdmiteTraspaso(estado: EstadoSoat): SoatError {
  exigirSoatVigente({ estado }); // Épica #14707: un descartado responde 409, no 400.
  if (estado === EstadoSoat.PAGADO) {
    return new SoatError(400, 'Este SOAT ya está pagado: su gestión no se traspasa. Si hay que rehacerlo, primero reversarlo con justificación.');
  }
  return new SoatError(400, `Este SOAT aún no se ha enviado a gestión (está en "${ESTADO_SOAT_LABEL[estado]}"). Elige el destino al enviarlo.`);
}

export function exigirMotivo(motivo: string, accion: string): string {
  const limpio = motivo?.trim() ?? '';
  if (limpio.length < MOTIVO_MINIMO) throw new SoatError(400, `${accion} exige un motivo que explique el porqué`);
  return limpio;
}

/** Reversa (RN-06): nunca DESDE `descartado` (409) y siempre con motivo (400). Mismo texto de siempre. */
export function exigirReversable(soat: { estado: string }, motivo: string): void {
  exigirSoatVigente(soat);
  exigirMotivo(motivo, 'La reversa');
}

/** RN-05 + Épica #14707: el proveedor no cambia en un descartado (409) ni en adquisición (400). */
export function exigirCambioProveedorAdmitido(soat: { estado: string }): void {
  exigirSoatVigente(soat);
  if (soat.estado === EstadoSoat.SOLICITADO) {
    throw new SoatError(400, 'RN-05: para cambiar el proveedor de un SOAT en adquisición, primero hay que reversarlo a Pendiente con justificación.');
  }
}
