// FLITO Trámites — BORRADOR ABANDONADO: la regla ÚNICA (Épica #14590, B2-AC2; decisión del humano del 2026-11-19).
//
// RN-TRA-B1: un trámite está abandonado en Borrador si su `flit_estado` es Borrador y entró a ese estado hace MÁS de N
//   días. La entrada al estado es el último cambio de `flit_estado` en `flito_tramite_historial`; si nunca cambió (nació
//   en Borrador: el historial solo registra UPDATE), la fecha de creación (`fecha_creacion_flit`, con respaldo en
//   `created_at`).
// RN-TRA-B2: N es el umbral configurable `dias_borrador_abandonado` de la Torre (`flito_torre_umbrales`); sin fila, el
//   `valorPorDefecto` del catálogo (= `ANS_OPERATIVO.BORRADOR_DIAS`). La alerta `borrador_5d` de Gestión Trámites y la
//   Torre (`borrador_abandonado`, la fila Borrador del inventario) usan ESTE fragmento y ESTE umbral: no pueden contar
//   distinto. Este módulo es el dueño del dato; la Torre lo importa (mismo precedente que `contarSinGestion`).
import { eq, sql, type SQL } from 'drizzle-orm';
import { UMBRALES_TORRE } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoTorreUmbrales, flitoTramiteHistorial, flitoTramites } from '../../db/schema.js';

const T = flitoTramites;
const H = flitoTramiteHistorial;

/** Fecha de creación del trámite: la de FLIT, con la de ingesta como respaldo. */
export const CREADO_TRAMITE = sql`COALESCE(${T.fechaCreacionFlit}, ${T.createdAt})`;

/** RN-TRA-B1: cuándo entró el trámite a su estado actual (último cambio de `flit_estado`, o su creación). */
export const ENTRADA_ESTADO_ACTUAL = sql`COALESCE((SELECT max(${H.createdAt}) FROM ${H}
    WHERE ${H.tramiteId} = ${T.id} AND ${H.campo} = 'flit_estado'), ${CREADO_TRAMITE})`;

/** El trámite está hoy en Borrador (sin distinguir mayúsculas ni espacios). */
export const EN_BORRADOR = sql`LOWER(TRIM(COALESCE(${T.flitEstado}, ''))) = 'borrador'`;

/** RN-TRA-B1: en Borrador desde hace más de `dias` días. `make_interval`: el parámetro queda tipado (no `$1 || ' days'`). */
export const BORRADOR_ABANDONADO = (dias: number): SQL =>
  sql`(${EN_BORRADOR} AND ${ENTRADA_ESTADO_ACTUAL} < now() - make_interval(days => ${dias}))`;

const CLAVE_UMBRAL = 'dias_borrador_abandonado';
const POR_DEFECTO = UMBRALES_TORRE.find((u) => u.clave === CLAVE_UMBRAL)!.valorPorDefecto;

/** RN-TRA-B2: el valor vigente del umbral (el mismo que lee la Torre con `valoresUmbrales`). */
export async function diasBorradorAbandonado(): Promise<number> {
  const [fila] = await db.select({ valor: flitoTorreUmbrales.valor }).from(flitoTorreUmbrales)
    .where(eq(flitoTorreUmbrales.clave, CLAVE_UMBRAL)).limit(1);
  return fila ? Number(fila.valor) : POR_DEFECTO;
}
