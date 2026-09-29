// FLITO sync — caché en memoria del pase de FLIT 2 (HU #13063, Feature #13057).
//
// Módulo aparte para que `flit2-acceso.service.ts` pueda descartar el pase al guardar un acceso
// (AC10) sin importar `flit2-pase.service.ts`, que a su vez lee el acceso: así no hay ciclo.
//
// El pase vive SOLO en la memoria de este proceso: no se guarda en la base, ni en Redis, ni va a un
// log. `authorization` viaja envuelto en `Redacted`, que se serializa como `[REDACTED]`.

import type { Redacted } from '../../shared/utils/crypto.js';

export interface Flit2Pase {
  /** `Bearer <jwt>`. `.unwrap()` solo al armar la cabecera de la petición a FLIT 2. */
  authorization: Redacted<string>;
  scope: string[];
  /** `true` si FLIT 2 concedió `external.tramites.pii.read`. */
  conPii: boolean;
  expiraEn: Date;
}

/** Pase por id de la fila de acceso que lo obtuvo: otra fila (acceso reemplazado) no lo reutiliza. */
const pases = new Map<number, Flit2Pase>();
/** Una sola petición de token en vuelo por fila, aunque lleguen varias a la vez. */
const enVuelo = new Map<number, Promise<Flit2Pase>>();
/** Sube con cada invalidación: un pase que llega DESPUÉS de invalidar no se guarda. */
let generacion = 0;

export function generacionActual(): number {
  return generacion;
}

export function paseEnCache(filaId: number): Flit2Pase | undefined {
  return pases.get(filaId);
}

/** Guarda el pase solo si nadie invalidó mientras se pedía. */
export function guardarPaseEnCache(filaId: number, pase: Flit2Pase, generacionAlPedir: number): void {
  if (generacionAlPedir !== generacion) return;
  pases.clear();
  pases.set(filaId, pase);
}

export function peticionEnVuelo(filaId: number): Promise<Flit2Pase> | undefined {
  return enVuelo.get(filaId);
}

export function registrarPeticionEnVuelo(filaId: number, peticion: Promise<Flit2Pase>): void {
  enVuelo.set(filaId, peticion);
  // `finally` sin propagar: el rechazo lo atiende quien espera `peticion`.
  peticion.then(
    () => { if (enVuelo.get(filaId) === peticion) enVuelo.delete(filaId); },
    () => { if (enVuelo.get(filaId) === peticion) enVuelo.delete(filaId); },
  );
}

/** Descarta el pase y las peticiones en vuelo (AC10: al guardar un acceso nuevo; ante un 401). */
export function invalidarPase(): void {
  generacion += 1;
  pases.clear();
  enVuelo.clear();
}
