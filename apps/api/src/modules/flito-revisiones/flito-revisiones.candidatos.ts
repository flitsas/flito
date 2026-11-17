// FLITO Revisiones — buscador de trámite para resolver una revisión OCR (Bug #14569, punto 8).
//
// La persona que resuelve tiene que elegir a qué registro pertenece el documento (`registroId` de
// `POST /:id/resolver`). Este buscador le ofrece SOLO registros que el resolver aceptaría:
//   - SOAT → `flito_soat` en `ESTADO_CANDIDATO.soat`, con las fronteras de la cola de SOAT
//     (`condicionesCola` + `conJoinsCola`, del dueño: no se reimplementan aquí).
//   - Impuestos / factura de venta → `flito_impuestos` en su `ESTADO_CANDIDATO`, con
//     `condicionesColaImpuestos` + `conJoinsColaImpuestos`.
//   - Derechos → trámites aprobados en FLIT (`buscarCandidatosRevision` de flito-derechos); los que ya
//     tienen su derecho se devuelven NO seleccionables, no se ocultan (decisión de producto).
//
// A las colas NO se les pasa `buscar`: su búsqueda mira nombre y documento de compradores, que es PII
// fuera del alcance de este buscador. El predicado de llaves es propio y solo mira N.º FLIT, placa y
// VIN, normalizados como `norm()` del front (mayúsculas, sin guiones ni espacios).

import { and, desc, eq, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  FlujoRevision, MOTIVO_CANDIDATO_YA_TIENE_DERECHO,
  type CandidatoRevisionDto, type CandidatosRevisionRespuesta,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoImpuestos, flitoRevisiones, flitoSoat, flitoTramites, vehicles } from '../../db/schema.js';
import { condicionesCola, conJoinsCola, contextoSoat } from '../flito-soat/flito-soat.service.js';
import { condicionesColaImpuestos, conJoinsColaImpuestos } from '../flito-impuestos/flito-impuestos.service.js';
import { buscarCandidatosRevision as candidatosDerecho } from '../flito-derechos/flito-derechos.candidatos-revision.js';
import { ESTADO_CANDIDATO, RevisionError } from './flito-revisiones.service.js';

type Usuario = { sub: number; username: string; role: string };

export interface FiltrosCandidatos { texto?: string; placa?: string; vin?: string; limite: number }

/** Normalización de llave, idéntica en JS y en SQL: mayúsculas, sin guiones ni espacios. */
export const normalizarLlave = (v: string): string => v.toUpperCase().replace(/[\s-]/g, '');
const norm = (x: SQL | AnyColumn): SQL => sql`UPPER(REPLACE(REPLACE(COALESCE(${x}, ''), '-', ''), ' ', ''))`;
/** `%texto%` con los comodines de LIKE escapados: un `_` tecleado no es «cualquier carácter». */
const patron = (t: string): string => `%${t.replace(/[\\%_]/g, '\\$&')}%`;

interface Llaves { texto: string; placa: string; vin: string }

function llavesDe(f: FiltrosCandidatos): Llaves {
  return {
    texto: f.texto?.trim() ? normalizarLlave(f.texto.trim()) : '',
    placa: f.placa?.trim() ? normalizarLlave(f.placa.trim()) : '',
    vin: f.vin?.trim() ? normalizarLlave(f.vin.trim()) : '',
  };
}

/** Cómo se compara el N.º FLIT de cada fuente (en SOAT vive en los trámites que lo referencian). */
interface ColumnasLlave {
  placa: AnyColumn;
  vin: AnyColumn;
  idFlitLike: (p: string) => SQL;
  idFlitIgual: (v: string) => SQL;
}

/**
 * Con texto → LIKE %n% sobre N.º FLIT, placa y VIN. Sin texto y con placa/VIN → igualdad exacta
 * (placa OR vin), no LIKE. Sin nada → sin acotar. `exacta` ordena primero las coincidencias exactas.
 */
export function predicadoLlaves(ll: Llaves, c: ColumnasLlave): { where?: SQL; exacta?: SQL } {
  let where: SQL | undefined;
  if (ll.texto) {
    const p = patron(ll.texto);
    where = or(sql`${norm(c.placa)} LIKE ${p}`, sql`${norm(c.vin)} LIKE ${p}`, c.idFlitLike(p));
  } else if (ll.placa || ll.vin) {
    where = or(
      ll.placa ? sql`${norm(c.placa)} = ${ll.placa}` : undefined,
      ll.vin ? sql`${norm(c.vin)} = ${ll.vin}` : undefined,
    );
  }
  const exactas: SQL[] = [];
  if (ll.placa) exactas.push(sql`${norm(c.placa)} = ${ll.placa}`);
  if (ll.vin) exactas.push(sql`${norm(c.vin)} = ${ll.vin}`);
  if (ll.texto) exactas.push(sql`${norm(c.placa)} = ${ll.texto}`, sql`${norm(c.vin)} = ${ll.texto}`, c.idFlitIgual(ll.texto));
  return { where, exacta: exactas.length ? or(...exactas) : undefined };
}

const ordenExacta = (exacta?: SQL): SQL[] => (exacta ? [sql`CASE WHEN ${exacta} THEN 0 ELSE 1 END`] : []);

// ─────────────────────────── DTO ─────────────────────────────────────────────

interface FilaBase { id: string; idFlit: string | null; placa: string | null; vin: string | null; detalle: string | null; yaTieneDerecho?: boolean }

function aDto(f: FilaBase, ll: Llaves): CandidatoRevisionDto {
  const yaTiene = f.yaTieneDerecho === true;
  return {
    id: f.id,
    idFlit: f.idFlit,
    placa: f.placa,
    vin: f.vin,
    etiqueta: `${f.idFlit ?? 'Sin N.º FLIT'} · ${f.placa ?? 'sin placa'}`,
    detalle: f.detalle,
    coincide: {
      placa: !!ll.placa && !!f.placa && normalizarLlave(f.placa) === ll.placa,
      vin: !!ll.vin && !!f.vin && normalizarLlave(f.vin) === ll.vin,
    },
    seleccionable: !yaTiene,
    motivoNoSeleccionable: yaTiene ? MOTIVO_CANDIDATO_YA_TIENE_DERECHO : null,
  };
}

const unir = (partes: (string | null | undefined)[], sep: string): string | null =>
  partes.filter((p): p is string => !!p && p.trim() !== '').join(sep) || null;

interface Resultado { filas: FilaBase[]; total: number }
type Fuente = (ll: Llaves, limite: number, user: Usuario) => Promise<Resultado>;

// ─────────────────────────── SOAT ────────────────────────────────────────────

/** N.º FLIT de un SOAT: los trámites que lo referencian (null en el canal Cliente, que no tiene trámite). */
const ID_FLIT_SOAT = sql<string | null>`(SELECT string_agg(ft.id_flit, ', ' ORDER BY ft.created_at) FROM ${flitoTramites} ft WHERE ft.soat_id = ${flitoSoat.id})`;
const COLUMNAS_LLAVE_SOAT: ColumnasLlave = {
  placa: vehicles.plate,
  vin: vehicles.vin,
  idFlitLike: (p) => sql`EXISTS (SELECT 1 FROM ${flitoTramites} ft WHERE ft.soat_id = ${flitoSoat.id} AND UPPER(REPLACE(REPLACE(ft.id_flit, '-', ''), ' ', '')) LIKE ${p})`,
  idFlitIgual: (v) => sql`EXISTS (SELECT 1 FROM ${flitoTramites} ft WHERE ft.soat_id = ${flitoSoat.id} AND UPPER(REPLACE(REPLACE(ft.id_flit, '-', ''), ' ', '')) = ${v})`,
};
const selectSoat = () => db.select({
  id: flitoSoat.id, idFlit: ID_FLIT_SOAT, placa: vehicles.plate, vin: vehicles.vin, marca: vehicles.brand, linea: vehicles.model,
}).from(flitoSoat).$dynamic();
type FilaSoat = { id: string; idFlit: string | null; placa: string | null; vin: string | null; marca: string | null; linea: string | null };
const filaSoat = (r: FilaSoat): FilaBase => ({ id: r.id, idFlit: r.idFlit, placa: r.placa, vin: r.vin, detalle: unir([r.marca, r.linea], ' ') });

const fuenteSoat: Fuente = async (ll, limite, user) => {
  const conds = condicionesCola(await contextoSoat(user), { estados: [ESTADO_CANDIDATO[FlujoRevision.SOAT]] });
  if (conds === null) return { filas: [], total: 0 };
  const { where, exacta } = predicadoLlaves(ll, COLUMNAS_LLAVE_SOAT);
  const w = and(...conds, ...(where ? [where] : []));
  const [rows, [c]] = await Promise.all([
    conJoinsCola(selectSoat()).where(w).orderBy(...ordenExacta(exacta), desc(flitoSoat.createdAt), desc(flitoSoat.id)).limit(limite),
    conJoinsCola(db.select({ n: sql<number>`count(*)::int` }).from(flitoSoat).$dynamic()).where(w),
  ]);
  return { filas: (rows as FilaSoat[]).map(filaSoat), total: Number(c?.n ?? 0) };
};

async function registroSoat(id: string): Promise<FilaBase | null> {
  const [r] = await conJoinsCola(selectSoat()).where(eq(flitoSoat.id, id)).limit(1);
  return r ? filaSoat(r as FilaSoat) : null;
}

// ─────────────────────────── Impuestos / factura de venta ────────────────────

const COLUMNAS_LLAVE_IMP: ColumnasLlave = {
  placa: vehicles.plate,
  vin: vehicles.vin,
  idFlitLike: (p) => sql`${norm(flitoTramites.idFlit)} LIKE ${p}`,
  idFlitIgual: (v) => sql`${norm(flitoTramites.idFlit)} = ${v}`,
};
const selectImp = () => db.select({
  id: flitoImpuestos.id, idFlit: flitoTramites.idFlit, placa: vehicles.plate, vin: vehicles.vin, organismoCodigo: flitoImpuestos.organismoCodigo,
}).from(flitoImpuestos).$dynamic();
type FilaImp = { id: string; idFlit: string | null; placa: string | null; vin: string | null; organismoCodigo: string | null };
const filaImp = (r: FilaImp): FilaBase => ({ id: r.id, idFlit: r.idFlit, placa: r.placa, vin: r.vin, detalle: r.organismoCodigo });

/**
 * El contexto de Impuestos vive en su router (`contextoImpuesto`). Import dinámico: cargar ese router
 * entero al importar este módulo arrastraría todas sus dependencias a la cola de revisión.
 */
async function ctxImpuesto(user: Usuario) {
  const { contextoImpuesto } = await import('../flito-impuestos/flito-impuestos.routes.js');
  return contextoImpuesto(user);
}

const fuenteImpuestos = (modulo: typeof FlujoRevision.IMPUESTOS | typeof FlujoRevision.FACTURA_VENTA): Fuente => async (ll, limite, user) => {
  const conds = condicionesColaImpuestos(await ctxImpuesto(user), { estados: [ESTADO_CANDIDATO[modulo]] });
  if (conds === null) return { filas: [], total: 0 };
  const { where, exacta } = predicadoLlaves(ll, COLUMNAS_LLAVE_IMP);
  const w = and(...conds, ...(where ? [where] : []));
  const [rows, [c]] = await Promise.all([
    conJoinsColaImpuestos(selectImp()).where(w).orderBy(...ordenExacta(exacta), desc(flitoImpuestos.createdAt), desc(flitoImpuestos.id)).limit(limite),
    conJoinsColaImpuestos(db.select({ n: sql<number>`count(*)::int` }).from(flitoImpuestos).$dynamic()).where(w),
  ]);
  return { filas: (rows as FilaImp[]).map(filaImp), total: Number(c?.n ?? 0) };
};

async function registroImp(id: string): Promise<FilaBase | null> {
  const [r] = await conJoinsColaImpuestos(selectImp()).where(eq(flitoImpuestos.id, id)).limit(1);
  return r ? filaImp(r as FilaImp) : null;
}

// ─────────────────────────── Derechos ────────────────────────────────────────

const COLUMNAS_LLAVE_DER: ColumnasLlave = COLUMNAS_LLAVE_IMP; // mismas tablas: flito_tramites + vehicles
const filaDer = (r: Awaited<ReturnType<typeof candidatosDerecho>>['filas'][number]): FilaBase => ({
  id: r.id, idFlit: r.idFlit, placa: r.placa, vin: r.vin,
  detalle: unir([r.tipoTramite, r.organismoCodigo], ' · '), yaTieneDerecho: r.yaTieneDerecho,
});

const fuenteDerechos: Fuente = async (ll, limite) => {
  const { where, exacta } = predicadoLlaves(ll, COLUMNAS_LLAVE_DER);
  const r = await candidatosDerecho({ where, exacta, limite });
  return { filas: r.filas.map(filaDer), total: r.total };
};

async function registroDer(id: string): Promise<FilaBase | null> {
  const r = await candidatosDerecho({ where: eq(flitoTramites.id, id), limite: 1, sinFiltroEstado: true });
  return r.filas[0] ? filaDer(r.filas[0]) : null;
}

// ─────────────────────────── Punto de entrada ────────────────────────────────

const FUENTES: Record<FlujoRevision, { buscar: Fuente; registro: (id: string) => Promise<FilaBase | null> }> = {
  [FlujoRevision.SOAT]: { buscar: fuenteSoat, registro: registroSoat },
  [FlujoRevision.IMPUESTOS]: { buscar: fuenteImpuestos(FlujoRevision.IMPUESTOS), registro: registroImp },
  [FlujoRevision.FACTURA_VENTA]: { buscar: fuenteImpuestos(FlujoRevision.FACTURA_VENTA), registro: registroImp },
  [FlujoRevision.DERECHOS]: { buscar: fuenteDerechos, registro: registroDer },
};

/**
 * Candidatos de una revisión. 404 si no existe. Resuelta → `items: []` (ya no hay nada que elegir),
 * pero con su `registroActual`. El `registroActual` se lee por id SIN filtro de estado: es el registro
 * que la revisión ya apunta, y la persona tiene que verlo aunque ya no sea candidato.
 */
export async function buscarCandidatos(revisionId: string, f: FiltrosCandidatos, user: Usuario): Promise<CandidatosRevisionRespuesta> {
  const [rev] = await db.select({ modulo: flitoRevisiones.modulo, registroId: flitoRevisiones.registroId, resuelto: flitoRevisiones.resuelto })
    .from(flitoRevisiones).where(eq(flitoRevisiones.id, revisionId)).limit(1);
  if (!rev) throw new RevisionError(404, 'La revisión no existe');
  const fuente = FUENTES[rev.modulo as FlujoRevision];
  if (!fuente) throw new RevisionError(400, 'Módulo de revisión desconocido');

  const ll = llavesDe(f);
  const [res, actual] = await Promise.all([
    rev.resuelto ? Promise.resolve<Resultado>({ filas: [], total: 0 }) : fuente.buscar(ll, f.limite, user),
    rev.registroId ? fuente.registro(rev.registroId) : Promise.resolve(null),
  ]);
  const items = res.filas.map((r) => aDto(r, ll));
  return { items, total: res.total, truncado: res.total > items.length, registroActual: actual ? aDto(actual, ll) : null };
}
