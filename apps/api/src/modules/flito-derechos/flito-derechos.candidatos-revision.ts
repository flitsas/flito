// FLITO Derechos — candidatos para el buscador de trámite de la cola de revisión OCR (Bug #14569, punto 8).
//
// Archivo propio y no una función más en `flito-derechos.service.ts`: ese servicio tiene techo
// congelado de líneas (eslint `max-lines`, ratchet) y no puede crecer.
//
// Mismos joins y misma lista blanca de estados de FLIT que `buscarCandidatos` (la cascada automática
// por placa), para que el humano vea exactamente el universo al que la máquina habría podido atar el
// recibo. La diferencia: aquí los trámites que YA tienen su derecho NO se excluyen, se devuelven
// marcados (`yaTieneDerecho`) para que la UI los pinte no seleccionables (decisión de producto del
// Bug #14569). La regla «un derecho por trámite» sigue viviendo en el servidor: `registrarDesdeRevision`
// la rechaza si alguien lo intenta igual.
//
// El predicado de llaves (placa / VIN / N.º FLIT) lo construye quien llama: aquí no se busca por
// compradores ni por documento (PII fuera del alcance del buscador).

import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoDerechosTramite, flitoTramites, vehicles } from '../../db/schema.js';
import { sqlEstadosConDerecho } from './flito-derechos.service.js';

export interface FilaCandidatoDerecho {
  id: string;
  idFlit: string | null;
  placa: string | null;
  vin: string | null;
  tipoTramite: string | null;
  organismoCodigo: string | null;
  createdAt: Date;
  yaTieneDerecho: boolean;
}

export interface OpcionesCandidatosDerecho {
  /** Predicado de llaves sobre `flito_tramites` / `vehicles`; undefined = sin acotar. */
  where?: SQL;
  /** Expresión booleana de «coincidencia exacta», para ordenar primero. */
  exacta?: SQL;
  limite: number;
  /**
   * true solo para leer el `registroActual` de una revisión por id: ese registro se enseña en el
   * estado que tenga, aunque ya no sea candidato.
   */
  sinFiltroEstado?: boolean;
}

const COLUMNAS = {
  id: flitoTramites.id,
  idFlit: flitoTramites.idFlit,
  placa: vehicles.plate,
  vin: vehicles.vin,
  tipoTramite: flitoTramites.tipoTramite,
  organismoCodigo: flitoTramites.organismoCodigo,
  createdAt: flitoTramites.createdAt,
  yaTieneDerecho: sql<boolean>`${flitoDerechosTramite.id} is not null`,
};

/** Trámites candidatos (filas, hasta `limite`) y cuántos cumplen el mismo filtro en total. */
export async function buscarCandidatosRevision(o: OpcionesCandidatosDerecho): Promise<{ filas: FilaCandidatoDerecho[]; total: number }> {
  const conds: SQL[] = [];
  if (!o.sinFiltroEstado) conds.push(sql`LOWER(COALESCE(${flitoTramites.flitEstado}, '')) IN (${sqlEstadosConDerecho()})`);
  if (o.where) conds.push(o.where);
  const where = conds.length ? and(...conds) : undefined;

  // `flito_derechos_tramite.tramite_id` es UNIQUE: el left join no multiplica filas, y el conteo cuadra.
  const filas = db.select(COLUMNAS).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .where(where)
    .orderBy(...(o.exacta ? [sql`CASE WHEN ${o.exacta} THEN 0 ELSE 1 END`] : []), desc(flitoTramites.createdAt), desc(flitoTramites.id))
    .limit(o.limite);
  const conteo = db.select({ n: sql<number>`count(*)::int` }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .where(where);

  const [rows, [c]] = await Promise.all([filas, conteo]);
  return { filas: rows as FilaCandidatoDerecho[], total: Number(c?.n ?? 0) };
}
