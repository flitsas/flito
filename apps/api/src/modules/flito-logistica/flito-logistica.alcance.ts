// HU #13426 (Feature #12871, ADR-0024 §4.4) — El alcance por ENLACE de Logística. El módulo se abre a
// `compania` (`FRONTERA_POR_ENLACE.logistica`): una compañía ve SOLO sus trámites, documentos y
// actas, y opera las suyas si su rol tiene la función (decisión P-2 del PO); lo ajeno → 403 en
// escritura (sin comprobar si existe: sin oráculo) y 404 en lectura. Sin enlace no se acota nada.
import { and, eq, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoLogisticaActas, flitoLogisticaDocumentos, flitoTramites } from '../../db/schema.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { AlcanceAjenoError, condicionPorCompania } from '../../shared/alcance-filas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Condición de alcance sobre los trámites del listado y las facetas. `undefined` = sin acotar. */
export const condicionTramitesLogistica = (a: AlcanceResuelto): SQL | undefined =>
  condicionPorCompania(flitoTramites.companiaId, a);

/** Condición de alcance sobre las actas. `undefined` = sin acotar. */
export const condicionActasLogistica = (a: AlcanceResuelto): SQL | undefined =>
  condicionPorCompania(flitoLogisticaActas.companiaId, a);

/** Condición de alcance sobre los documentos (compañías cerrables). `undefined` = sin acotar. */
export const condicionDocumentosLogistica = (a: AlcanceResuelto): SQL | undefined =>
  condicionPorCompania(flitoLogisticaDocumentos.companiaId, a);

type Recurso = 'acta' | 'documento' | 'tramite';

/** Una consulta por recurso, con el alcance EN EL WHERE. */
async function existePropio(recurso: Recurso, id: string, cond: SQL): Promise<boolean> {
  switch (recurso) {
    case 'acta': {
      const [f] = await db.select({ id: flitoLogisticaActas.id }).from(flitoLogisticaActas)
        .where(and(eq(flitoLogisticaActas.id, id), cond)).limit(1);
      return !!f;
    }
    case 'documento': {
      const [f] = await db.select({ id: flitoLogisticaDocumentos.id }).from(flitoLogisticaDocumentos)
        .where(and(eq(flitoLogisticaDocumentos.id, id), cond)).limit(1);
      return !!f;
    }
    default: {
      const [f] = await db.select({ id: flitoTramites.id }).from(flitoTramites)
        .where(and(eq(flitoTramites.id, id), cond)).limit(1);
      return !!f;
    }
  }
}

const CONDICION: Record<Recurso, (a: AlcanceResuelto) => SQL | undefined> = {
  acta: condicionActasLogistica, documento: condicionDocumentosLogistica, tramite: condicionTramitesLogistica,
};

/** ¿Está el recurso dentro del alcance? Sin enlace, sí sin consultar. */
export async function enAlcanceLogistica(recurso: Recurso, id: string, a: AlcanceResuelto): Promise<boolean> {
  const cond = CONDICION[recurso](a);
  if (!cond) return true;
  if (!UUID.test(id)) return false;
  return existePropio(recurso, id, cond);
}

/** Escritura (AC3): 403 si el recurso no es de su compañía (o no existe), antes de tocar nada. */
export async function exigirPropioLogistica(recurso: Recurso, id: string, a: AlcanceResuelto): Promise<void> {
  if (!await enAlcanceLogistica(recurso, id, a)) throw new AlcanceAjenoError();
}
