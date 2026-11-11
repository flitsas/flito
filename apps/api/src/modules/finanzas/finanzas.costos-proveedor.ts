// Reporte de costos — el COSTO DE PROVEEDOR de cada trámite (ADR-0041 §13, Enmienda 1; Épica #13763).
//
// Lo que el proveedor le cobra a FLIT por el SOAT y por la logística de un trámite. Es INFORMATIVO:
// se enseña al lado del cobro y se congela al sellar, pero no es cobro. Reglas (C1–C8 del humano):
//
//   RN-CP-01 (C1) Columnas nuevas que NO suman: nada de aquí entra en `EXPR_TOTAL`, `EXPR_BASE_GMF`,
//            RN-02 (reintegro/servicio), `TotalesReporte`, el consolidado, `faltantes`,
//            `EXPR_BLOQUEADA`, `noConfigurados`, bolsas ni Siigo. Este archivo es el ÚNICO lector de
//            `flito_tarifas_proveedor_vigencias` fuera de la parametrización.
//   RN-CP-02 (C2) SOAT con trámite: `flito_tramites.soat_id → flito_soat.proveedor_soat_id`, vigencia
//            `soat_con_tramite` en `flito_soat.enviado_en`. H-1: sin `enviado_en` ⇒ `sin_proveedor`
//            hasta que se envíe (no hay valor estimado). H-4: si FLITO no gestiona el SOAT del
//            trámite (la compañía lo autogestiona sin excepción) ⇒ `sin_proveedor`.
//   RN-CP-03 (C3) SOAT compartido: cuenta en el primer trámite por `(created_at, id)` entre TODOS los
//            que tienen ese `soat_id`, sin mirar la compañía ni el filtro del reporte (H-5). Los
//            demás ⇒ `ya_contado` con el trámite donde se contó.
//   RN-CP-04 (C4) Logística, valor fijo por trámite: la PRIMERA ENTREGA VÁLIDA (H-3) de la licencia de
//            tránsito del trámite; válida = traslado no `legado` y acta creada desde el corte del
//            proveedor por defecto (`flito_logistica_corte_proveedor`, mismo criterio que
//            `actasDelProveedor`). Proveedor = el del acta; vigencia `logistica` en su
//            `entregado_en`. Viajes adicionales y entregas posteriores no cambian el valor.
//            FLITO no gestiona la logística ⇒ `sin_proveedor`.
//   RN-CP-05 (C5) SOAT sin trámite: fuera. `soat_sin_tramite` no se lee aquí.
//   RN-CP-06 (C6) Congelar al sellar: `liquidar()` guarda `detalle.costosProveedor`. Un concepto que
//            aún espera su evento (SOAT sin enviar, logística sin entrega válida: H-1/H-2) se guarda
//            `null` y se lee en vivo, marcado `estimado` cuando hay valor. Lo que tenía valor (o un
//            estado definitivo) al sellar queda congelado. Sellos anteriores sin la clave: en vivo.
//   RN-CP-07 (C7) «Sin configurar» avisa y NO bloquea: proveedor resuelto sin vigencia en la fecha
//            del evento. Filtro propio `costoProveedorSinConfigurar`.
//   RN-CP-08 (C8) El proveedor no lo ve: solo se proyecta en `/api/finanzas/*`, montado sin
//            `conAlcance` (403 a todo enlace ≠ `ninguno`). `LiquidacionDto` no expone la clave.
//
// Por qué subconsultas correlacionadas y no joins: el mismo motivo que `finanzas.conciliacion-soat.ts`
// —un valor por fila POR CONSTRUCCIÓN, sin tocar `conJoins` ni el plan del conteo y los totales—.
//
// Las reglas «gestiona SOAT/logística» viven en `finanzas.service.ts` y llegan por parámetro
// (fábrica) para no cerrar el ciclo `flito-liquidacion → aquí → finanzas.service → flito-liquidacion`.

import { eq, sql, type SQL } from 'drizzle-orm';
import type {
  CostoProveedorConcepto, CostosProveedorSellados, EstadoCostoProveedor, EstadoCostoProveedorSellado,
} from '@operaciones/shared-types';
import { ESTADOS_COSTO_PROVEEDOR } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoLiquidaciones, flitoSoat, flitoTramites } from '../../db/schema.js';
import { aIso } from '../../shared/utils/fecha-rango.js';

/** Las reglas «gestiona», como SQL sobre la fila del trámite (reporte) o como literal (sellado). */
export interface GestionaSql { gestionaSoat: SQL; gestionaLogistica: SQL }

/** Un objeto con TODAS las claves del contrato; las que no se pasan, en null (contrato estable). */
function objeto(estado: SQL | string, resto: Partial<Record<Exclude<keyof CostoProveedorConcepto, 'estado'>, SQL>> = {}): SQL {
  const v = (k: keyof typeof resto): SQL => resto[k] ?? sql`NULL`;
  const e = typeof estado === 'string' ? sql.raw(`'${estado}'`) : estado;
  return sql`jsonb_build_object('estado', ${e}, 'proveedorId', ${v('proveedorId')}, 'proveedor', ${v('proveedor')},
    'vigenciaId', ${v('vigenciaId')}, 'valor', ${v('valor')}, 'fechaReferencia', ${v('fechaReferencia')},
    'contadoEnTramiteId', ${v('contadoEnTramiteId')}, 'contadoEnIdFlit', ${v('contadoEnIdFlit')})`;
}

const SIN_PROVEEDOR = objeto('sin_proveedor');

/** RN-CP-02/03 — el primer trámite (created_at, id) de este SOAT NO es este: ya se contó allí. */
const HAY_UNO_ANTERIOR = sql`EXISTS (
  SELECT 1 FROM flito_tramites p1
   WHERE p1.soat_id = ${flitoTramites.soatId}
     AND (p1.created_at, p1.id) < (${flitoTramites.createdAt}, ${flitoTramites.id}))`;

const YA_CONTADO = sql`(
  SELECT ${objeto('ya_contado', { contadoEnTramiteId: sql`p1.id`, contadoEnIdFlit: sql`p1.id_flit` })}
    FROM flito_tramites p1
   WHERE p1.soat_id = ${flitoTramites.soatId}
   ORDER BY p1.created_at, p1.id
   LIMIT 1)`;

/** Proyección del proveedor resuelto `p` y su vigencia `v` (LEFT): `costo` o `sin_configurar` (RN-CP-07). */
function conVigencia(ref: SQL): SQL {
  return objeto(sql`CASE WHEN v.id IS NULL THEN 'sin_configurar' ELSE 'costo' END`, {
    proveedorId: sql`p.id`, proveedor: sql`p.nombre`, vigenciaId: sql`v.id`, valor: sql`v.valor`, fechaReferencia: ref,
  });
}

/** La vigencia del concepto que CONTIENE `ref`, rango semiabierto (misma forma que `vigenteEn`, Bug #12682). */
const vigenciaEn = (concepto: 'soat_con_tramite' | 'logistica', ref: SQL): SQL => sql`v.proveedor_id = p.id
  AND v.concepto = ${concepto} AND tstzrange(v.vigente_desde, v.vigente_hasta, '[)') @> ${ref}::timestamptz`;

/** RN-CP-02/03/04 (H-1, H-4, H-5) — SOAT en vivo. El orden de los `WHEN` es la prioridad de estados. */
function soatVivo(g: GestionaSql): SQL {
  return sql`(CASE
    WHEN ${flitoTramites.soatId} IS NULL OR NOT ${g.gestionaSoat} THEN ${SIN_PROVEEDOR}
    WHEN ${flitoSoat.gestionOperaciones} THEN ${objeto('gestionado_operaciones')}
    WHEN ${HAY_UNO_ANTERIOR} THEN ${YA_CONTADO}
    WHEN ${flitoSoat.proveedorSoatId} IS NULL OR ${flitoSoat.enviadoEn} IS NULL THEN ${SIN_PROVEEDOR}
    ELSE COALESCE((
      SELECT ${conVigencia(sql`${flitoSoat.enviadoEn}`)}
        FROM flito_proveedores p
        LEFT JOIN flito_tarifas_proveedor_vigencias v ON ${vigenciaEn('soat_con_tramite', sql`${flitoSoat.enviadoEn}`)}
       WHERE p.id = ${flitoSoat.proveedorSoatId}), ${SIN_PROVEEDOR})
  END)`;
}

/**
 * RN-CP-04 (H-3) — la primera entrega VÁLIDA de la licencia de tránsito, ya proyectada; NULL si no
 * hay ninguna. Separada para que el sellado sepa distinguir «no hay entrega aún» (abierto, H-2) del
 * resto. Sin corte sembrado, la comparación no excluye (mismo comportamiento que `desdeElCorte`).
 */
const PRIMERA_ENTREGA_VALIDA = sql`(
  SELECT CASE WHEN a.proveedor_logistica_id IS NULL OR p.id IS NULL THEN ${SIN_PROVEEDOR}
              ELSE ${conVigencia(sql`a.entregado_en`)} END
    FROM flito_logistica_documentos d
    JOIN flito_logistica_traslado_lts l ON l.documento_id = d.id AND l.estado = 'entregado'
    JOIN flito_logistica_traslados tr   ON tr.id = l.traslado_id AND NOT tr.legado
    JOIN flito_logistica_actas a        ON a.traslado_id = tr.id AND a.entregado_en IS NOT NULL
         AND a.created_at >= COALESCE((SELECT c.corte_en FROM flito_logistica_corte_proveedor c), '-infinity'::timestamptz)
    LEFT JOIN flito_proveedores p ON p.id = a.proveedor_logistica_id
    LEFT JOIN flito_tarifas_proveedor_vigencias v ON ${vigenciaEn('logistica', sql`a.entregado_en`)}
   WHERE d.tramite_id = ${flitoTramites.id} AND d.tipo = 'licencia_transito'
   ORDER BY a.entregado_en, a.id
   LIMIT 1)`;

function logisticaVivo(g: GestionaSql): SQL {
  return sql`(CASE WHEN NOT ${g.gestionaLogistica} THEN ${SIN_PROVEEDOR}
    ELSE COALESCE(${PRIMERA_ENTREGA_VALIDA}, ${SIN_PROVEEDOR}) END)`;
}

/** Los dos conceptos en vivo (lo que se congela al sellar). */
export function exprCostosProveedor(g: GestionaSql): { soatVivo: SQL; logisticaVivo: SQL } {
  return { soatVivo: soatVivo(g), logisticaVivo: logisticaVivo(g) };
}

/**
 * RN-CP-06 — lo que lee el reporte: el sello manda si congeló el concepto; si no (sello sin la clave,
 * o concepto `null`), el vivo, marcado `estimado` cuando trae valor. Sin sello, el vivo. El vivo se
 * evalúa UNA vez (subconsulta con `x`), no una por rama.
 */
function selladoOVivo(concepto: 'soat' | 'logistica', vivo: SQL): SQL {
  const sellado = sql`${flitoLiquidaciones.detalle}->'costosProveedor'->${concepto}`;
  return sql`(CASE
    WHEN ${flitoLiquidaciones.id} IS NOT NULL AND jsonb_typeof(${sellado}) = 'object' THEN ${sellado}
    WHEN ${flitoLiquidaciones.id} IS NOT NULL THEN (
      SELECT CASE WHEN q.x->>'estado' = 'costo' THEN q.x || '{"estado":"estimado"}'::jsonb ELSE q.x END
        FROM (SELECT ${vivo} AS x) q)
    ELSE ${vivo}
  END)`;
}

export interface ExprCostosReporte { soat: SQL; logistica: SQL; sinConfigurar: SQL }

/** Las expresiones del reporte (página, exportación y filtro), con las reglas «gestiona» del reporte. */
export function exprCostosProveedorReporte(g: GestionaSql): ExprCostosReporte {
  const soat = selladoOVivo('soat', soatVivo(g));
  const logistica = selladoOVivo('logistica', logisticaVivo(g));
  return {
    soat, logistica,
    // RN-CP-07 — solo filtra; no entra en `EXPR_BLOQUEADA` ni en `EXPR_INCOMPLETA`.
    sinConfigurar: sql`((${soat})->>'estado' = 'sin_configurar' OR (${logistica})->>'estado' = 'sin_configurar')`,
  };
}

/** Lo que el reporte añade a cada fila. Informativo (RN-CP-01): `costoProveedorTotal` NO es `total`. */
export interface CostosProveedorDeFila {
  costoProveedorSoat: CostoProveedorConcepto;
  costoProveedorLogistica: CostoProveedorConcepto;
  /** Σ de los `valor` no nulos; null si ninguno tiene valor. No entra en `total` (C1). */
  costoProveedorTotal: number | null;
}

/** Las columnas jsonb para el spread en `SELECT_FILA`. */
export function selectCostosProveedor(e: ExprCostosReporte) {
  return {
    costoProveedorSoat: sql<unknown>`${e.soat}`,
    costoProveedorLogistica: sql<unknown>`${e.logistica}`,
  } as const;
}

const textoONull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** El jsonb (objeto o texto, según driver) → concepto del contrato. `valor` llega como número o texto. */
export function conceptoDe(v: unknown): CostoProveedorConcepto {
  const o = (typeof v === 'string' ? JSON.parse(v) : v ?? {}) as Record<string, unknown>;
  const estado = (ESTADOS_COSTO_PROVEEDOR as readonly string[]).includes(o.estado as string)
    ? (o.estado as EstadoCostoProveedor) : 'sin_proveedor';
  const valor = o.valor === null || o.valor === undefined || o.valor === '' ? null : Number(o.valor);
  return {
    estado,
    proveedorId: textoONull(o.proveedorId), proveedor: textoONull(o.proveedor),
    vigenciaId: textoONull(o.vigenciaId),
    valor: valor !== null && Number.isFinite(valor) ? valor : null,
    fechaReferencia: o.fechaReferencia ? aIso(o.fechaReferencia) : null,
    contadoEnTramiteId: textoONull(o.contadoEnTramiteId), contadoEnIdFlit: textoONull(o.contadoEnIdFlit),
  };
}

export function costosProveedorDeFila(r: Record<string, unknown>): CostosProveedorDeFila {
  const costoProveedorSoat = conceptoDe(r.costoProveedorSoat);
  const costoProveedorLogistica = conceptoDe(r.costoProveedorLogistica);
  const valores = [costoProveedorSoat.valor, costoProveedorLogistica.valor].filter((x): x is number => x !== null);
  return {
    costoProveedorSoat, costoProveedorLogistica,
    costoProveedorTotal: valores.length === 0 ? null : Math.round(valores.reduce((a, b) => a + b, 0) * 100) / 100,
  };
}

/** `db` o la `tx` de `liquidar()`: solo se usa `select`. */
type Ejecutor = Pick<typeof db, 'select'>;

const literal = (b: boolean): SQL => sql.raw(b ? 'true' : 'false');

/**
 * RN-CP-06 — lo que se congela en `detalle.costosProveedor` al sellar, con las MISMAS expresiones
 * vivas del reporte. `gestiona*` sale del `calcular()` de la liquidación (la regla que ya decide si
 * SOAT/logística bloquean). Un concepto que aún espera su evento se guarda `null` (abierto):
 *   - SOAT gestionado, no de Operaciones, sin `enviado_en` y sin contar en otro trámite (H-1);
 *   - logística gestionada sin ninguna entrega válida aún (H-2).
 */
export async function costosProveedorParaSellar(
  ej: Ejecutor, tramiteId: string, g: { gestionaSoat: boolean; gestionaLogistica: boolean },
): Promise<CostosProveedorSellados> {
  const gs: GestionaSql = { gestionaSoat: literal(g.gestionaSoat), gestionaLogistica: literal(g.gestionaLogistica) };
  const { soatVivo: soat, logisticaVivo: logistica } = exprCostosProveedor(gs);
  const [r] = await ej.select({
    soat: sql<unknown>`${soat}`,
    logistica: sql<unknown>`${logistica}`,
    soatAbierto: sql<boolean>`(${gs.gestionaSoat} AND ${flitoTramites.soatId} IS NOT NULL
      AND NOT COALESCE(${flitoSoat.gestionOperaciones}, false) AND ${flitoSoat.enviadoEn} IS NULL
      AND NOT ${HAY_UNO_ANTERIOR})`,
    logisticaAbierta: sql<boolean>`(${gs.gestionaLogistica} AND ${PRIMERA_ENTREGA_VALIDA} IS NULL)`,
  }).from(flitoTramites)
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .where(eq(flitoTramites.id, tramiteId));
  if (!r) return { version: 1, soat: null, logistica: null };
  const sellar = (v: unknown, abierto: boolean) =>
    abierto ? null : (conceptoDe(v) as CostoProveedorConcepto & { estado: EstadoCostoProveedorSellado });
  return { version: 1, soat: sellar(r.soat, Boolean(r.soatAbierto)), logistica: sellar(r.logistica, Boolean(r.logisticaAbierta)) };
}
