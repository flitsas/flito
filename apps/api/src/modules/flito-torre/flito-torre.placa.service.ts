// Torre de Control Gerencial (Épica #14590, ADR-0043 checklist §5) — ficha de una placa.
//
// RN-TOR-P1: la placa llega en el BODY (`POST /placa/buscar`) y se busca por `upper(plate_complete)` (índice de la 0303).
// RN-TOR-P2: «no existe» y «fuera del alcance» son el MISMO 404 (`PlacaTorreNoEncontradaError`): el alcance va en el
//   `WHERE`, así que no hay forma de distinguirlos ni por tiempo de respuesta.
// RN-TOR-P3: sin datos de `flito_compradores` ni del propietario; el VIN sale enmascarado (solo los 4 últimos); de SOAT,
//   impuesto, derecho y logística solo el ESTADO, nunca valores.
// RN-TOR-P4: la línea de tiempo sale de `flito_tramite_historial` con `campo='flit_estado'`. «Radicado» es la primera vez
//   que el trámite pasó a «Entregado» o «Enviado a OT»; «Facturado», la primera factura de Siigo activa.
// RN-TOR-P5 (ADR-0044): sugerencias — el texto se normaliza a mayúsculas (3 a 7 `[A-Z0-9]`) y se busca en CUALQUIER
//   parte de `upper(plate_complete)` (índice trigram de la 0304). UNA sugerencia por placa (≤ 8 distintas) con la
//   compañía y el `flit_estado` de su trámite MÁS RECIENTE dentro del alcance; sin conteo de trámites ni datos del
//   comprador. Primero las que empiezan por el texto, luego por recencia. `hayMas` si había una novena.
// RN-TOR-P6: el alcance va en el `WHERE` (como RN-TOR-P2): fuera de alcance = `200 { sugerencias: [], hayMas: false }`.
//   Sin caché Redis; `statement_timeout` de 3 s; `%`, `_` y `\` se escapan del `LIKE` aunque Zod ya los rechaza. Ni el
//   servicio ni la ruta loguean el texto.
// La ruta registra `logPiiAccess` (accion `search`, campo `placa`); este servicio no loguea la placa.
import { eq, inArray, sql } from 'drizzle-orm';
import {
  ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL, SUGERENCIAS_PLACA_TORRE,
  type EstadoImpuesto, type EstadoSoat, type FichaPlacaTorre, type ResultadoBusquedaPlaca, type SugerenciasPlacaTorre,
} from '@operaciones/shared-types';
import {
  clients, flitoDerechosTramite, flitoImpuestos, flitoLiquidaciones, flitoSoat, flitoTramiteHistorial, flitoTramites,
  flitoTramiteViajesLogistica, siigoFacturaTramites, vehicles,
} from '../../db/schema.js';
import { condicionPorCompania } from '../../shared/alcance-filas.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { aIso } from '../../shared/utils/fecha-rango.js';
import { enTorre, nombreOrganismo } from './flito-torre.metricas.service.js';
import { ErrorDominioTorre } from './flito-torre.service.js';

export class PlacaTorreNoEncontradaError extends ErrorDominioTorre {
  readonly code = 'PLACA_NO_ENCONTRADA';
  constructor() { super('No encontramos esa placa en FLITO.'); }
}

/** Trámites por placa que se devuelven como máximo (del más reciente al más antiguo). */
const MAX_TRAMITES = 20;
const ESTADOS_RADICADO = ['entregado', 'enviado a ot'];

/** RN-TOR-P3: solo los 4 últimos caracteres. */
export function enmascararVin(vin: string | null | undefined): string | null {
  const v = vin?.trim();
  if (!v) return null;
  if (v.length <= 4) return '*'.repeat(v.length);
  return `${'*'.repeat(v.length - 4)}${v.slice(-4)}`;
}

const T = flitoTramites;
const H = flitoTramiteHistorial;

interface FilaPlaca {
  id: string; placa: string | null; tipo: string | null; compania_id: number | null; compania: string | null;
  organismo: string | null; organismo_flit: string | null; flit_estado: string | null;
  creado_flit: unknown; creado_sync: unknown; aprobado: unknown; vin: string | null;
  soat_id: string | null; soat_estado: string | null; soat_vence: unknown;
  radicado: unknown; facturado: unknown; imp_estado: string | null; imp_pagado: unknown;
  derecho_fecha: unknown; derecho_existe: boolean; logistica: unknown; viajes: number;
}

const horasEntre = (desde: string, hasta: string): number =>
  Math.round(((new Date(hasta).getTime() - new Date(desde).getTime()) / 3_600_000) * 10) / 10;

function aFicha(f: FilaPlaca, lineaTiempo: FichaPlacaTorre['lineaTiempo'], ahora: Date): FichaPlacaTorre {
  const creadoFlit = aIso(f.creado_flit);
  const creado = creadoFlit ?? aIso(f.creado_sync);
  const aprobado = aIso(f.aprobado);
  const viajes = Number(f.viajes ?? 0);
  const logisticaLiquidada = Number(f.logistica ?? 0) > 0;
  return {
    tramiteUuid: f.id,
    placa: f.placa ?? '',
    tipoTramite: f.tipo,
    vinMascara: enmascararVin(f.vin),
    compania: { id: f.compania_id, nombre: f.compania },
    organismo: { codigo: f.organismo, nombre: f.organismo ? nombreOrganismo(f.organismo) : f.organismo_flit },
    flitEstado: f.flit_estado,
    fechaCreacion: creado,
    fechaAprobacion: aprobado,
    duracionHoras: creado ? horasEntre(creado, aprobado ?? ahora.toISOString()) : null,
    baseFecha: { campo: creadoFlit ? 'fecha_creacion_flit' : 'created_at', conFallback: !creadoFlit },
    pasos: { creado, radicado: aIso(f.radicado), aprobado, facturado: aIso(f.facturado) },
    lineaTiempo,
    soat: f.soat_id
      ? { estado: ESTADO_SOAT_LABEL[f.soat_estado as EstadoSoat] ?? f.soat_estado ?? 'Sin estado', fecha: aIso(f.soat_vence) }
      : { estado: 'Sin SOAT', fecha: null },
    impuesto: f.imp_estado
      ? { estado: ESTADO_IMPUESTO_LABEL[f.imp_estado as EstadoImpuesto] ?? f.imp_estado, fecha: aIso(f.imp_pagado) }
      : { estado: 'Sin impuesto', fecha: null },
    derecho: f.derecho_existe ? { estado: 'Pagado', fecha: aIso(f.derecho_fecha) } : { estado: 'Sin registro', fecha: null },
    logistica: logisticaLiquidada
      ? { estado: viajes > 0 ? `Liquidada · ${viajes} ${viajes === 1 ? 'viaje adicional' : 'viajes adicionales'}` : 'Liquidada', fecha: aprobado }
      : { estado: 'Sin liquidar', fecha: null },
  };
}

/** Busca una placa dentro del alcance. Lanza `PlacaTorreNoEncontradaError` si no hay ninguno (RN-TOR-P2). */
export async function buscarPlaca(placa: string, alcance: AlcanceResuelto, ahora: Date = new Date()): Promise<ResultadoBusquedaPlaca> {
  const normalizada = placa.trim().toUpperCase();
  const porAlcance = condicionPorCompania(T.companiaId, alcance);
  return enTorre(async (q) => {
    const filas = await q<FilaPlaca>(sql`SELECT ${T.id} AS id, ${T.plateComplete} AS placa, ${T.tipoTramite} AS tipo,
        ${T.companiaId} AS compania_id, ${clients.name} AS compania, ${T.organismoCodigo} AS organismo,
        ${T.transitoNombreFlit} AS organismo_flit, ${T.flitEstado} AS flit_estado,
        ${T.fechaCreacionFlit} AS creado_flit, ${T.createdAt} AS creado_sync, ${T.fechaAprobacion} AS aprobado,
        ${vehicles.vin} AS vin, ${T.soatId} AS soat_id, ${flitoSoat.estado} AS soat_estado, ${flitoSoat.venceEl} AS soat_vence,
        (SELECT min(${H.createdAt}) FROM ${H} WHERE ${H.tramiteId} = ${T.id} AND ${H.campo} = 'flit_estado'
           AND lower(${H.valorNuevo}) IN ${ESTADOS_RADICADO}) AS radicado,
        (SELECT min(${siigoFacturaTramites.createdAt}) FROM ${siigoFacturaTramites}
           WHERE ${siigoFacturaTramites.tramiteId} = ${T.id} AND ${siigoFacturaTramites.activo} = true) AS facturado,
        (SELECT ${flitoImpuestos.estado}::text FROM ${flitoImpuestos} WHERE ${flitoImpuestos.tramiteId} = ${T.id}
           ORDER BY ${flitoImpuestos.createdAt} DESC LIMIT 1) AS imp_estado,
        (SELECT ${flitoImpuestos.pagadoEn} FROM ${flitoImpuestos} WHERE ${flitoImpuestos.tramiteId} = ${T.id}
           ORDER BY ${flitoImpuestos.createdAt} DESC LIMIT 1) AS imp_pagado,
        (SELECT max(${flitoDerechosTramite.fechaPago}) FROM ${flitoDerechosTramite} WHERE ${flitoDerechosTramite.tramiteId} = ${T.id}) AS derecho_fecha,
        EXISTS (SELECT 1 FROM ${flitoDerechosTramite} WHERE ${flitoDerechosTramite.tramiteId} = ${T.id}) AS derecho_existe,
        ${flitoLiquidaciones.valorLogistica} AS logistica,
        (SELECT count(*)::int FROM ${flitoTramiteViajesLogistica} WHERE ${flitoTramiteViajesLogistica.tramiteId} = ${T.id}) AS viajes
      FROM ${T}
        LEFT JOIN ${clients} ON ${eq(clients.id, T.companiaId)}
        LEFT JOIN ${vehicles} ON ${eq(vehicles.id, T.vehiculoId)}
        LEFT JOIN ${flitoSoat} ON ${eq(flitoSoat.id, T.soatId)}
        LEFT JOIN ${flitoLiquidaciones} ON ${eq(flitoLiquidaciones.tramiteId, T.id)}
      WHERE upper(${T.plateComplete}) = ${normalizada} ${porAlcance ? sql`AND (${porAlcance})` : sql``}
      ORDER BY COALESCE(${T.fechaCreacionFlit}, ${T.createdAt}) DESC
      LIMIT ${MAX_TRAMITES}`);
    if (!filas.length) throw new PlacaTorreNoEncontradaError();

    const historial = await q<{ tramite_id: string; anterior: string | null; nuevo: string | null; en: unknown }>(sql`
      SELECT ${H.tramiteId} AS tramite_id, ${H.valorAnterior} AS anterior, ${H.valorNuevo} AS nuevo, ${H.createdAt} AS en
      FROM ${H} WHERE ${H.campo} = 'flit_estado' AND ${inArray(H.tramiteId, filas.map((f) => f.id))}
      ORDER BY ${H.createdAt} ASC`);
    const porTramite = new Map<string, FichaPlacaTorre['lineaTiempo']>();
    for (const h of historial) {
      const lista = porTramite.get(h.tramite_id) ?? [];
      lista.push({ estado: h.nuevo ?? 'Sin estado', anterior: h.anterior, desde: aIso(h.en) ?? '' });
      porTramite.set(h.tramite_id, lista);
    }
    return { placa: normalizada, tramites: filas.map((f) => aFicha(f, porTramite.get(f.id) ?? [], ahora)) };
  });
}

/** Escapa los metacaracteres del `LIKE` (`\`, `%`, `_`): el patrón se arma con `ESCAPE '\'`. */
export const escaparLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** RN-TOR-P5/P6: sugerencias «contiene» de placa (≤ 8 placas distintas + `hayMas`). */
export async function sugerirPlacas(texto: string, alcance: AlcanceResuelto): Promise<SugerenciasPlacaTorre> {
  const t = texto.trim().toUpperCase();
  const { MIN_CARACTERES, MAX_CARACTERES, MAX_RESULTADOS } = SUGERENCIAS_PLACA_TORRE;
  if (t.length < MIN_CARACTERES || t.length > MAX_CARACTERES) return { sugerencias: [], hayMas: false };
  const patron = escaparLike(t);
  const porAlcance = condicionPorCompania(T.companiaId, alcance);
  const placa = sql`upper(${T.plateComplete})`;
  return enTorre(async (q) => {
    const filas = await q<{ placa: string; compania: string | null; flit_estado: string | null }>(sql`
      SELECT placa, compania, flit_estado FROM (
        SELECT DISTINCT ON (${placa}) ${placa} AS placa, ${clients.name} AS compania, ${T.flitEstado} AS flit_estado,
          (${placa} LIKE ${`${patron}%`} ESCAPE '\\') AS prefijo,
          COALESCE(${T.fechaCreacionFlit}, ${T.createdAt}) AS reciente
        FROM ${T} LEFT JOIN ${clients} ON ${eq(clients.id, T.companiaId)}
        WHERE ${placa} LIKE ${`%${patron}%`} ESCAPE '\\' ${porAlcance ? sql`AND (${porAlcance})` : sql``}
        ORDER BY ${placa}, COALESCE(${T.fechaCreacionFlit}, ${T.createdAt}) DESC, ${T.id} DESC
      ) s
      ORDER BY prefijo DESC, reciente DESC, placa ASC
      LIMIT ${MAX_RESULTADOS + 1}`);
    return {
      sugerencias: filas.slice(0, MAX_RESULTADOS).map((f) => ({ placa: f.placa, compania: f.compania ?? null, flitEstado: f.flit_estado ?? null })),
      hayMas: filas.length > MAX_RESULTADOS,
    };
  }, { timeout: '3s' });
}
