// Torre de Control Gerencial (Épica #14590, UX §7.2) — tablero Operativo. EXTIENDE `flito-tablero` sin duplicarlo: el
// SOAT y el impuesto sin gestión salen de `contarSinGestion()` de ese servicio, con el umbral configurable.
//
// RN-TOR-O1 (radar, foto del momento, ignora el rango): SOAT e impuesto solicitados sin gestión por más de
//   `horas_soat_impuesto_sin_soporte`; borradores con más de `dias_borrador_abandonado`; trámites «Entregado»/«Enviado
//   a OT» sin aprobar desde hace más de `dias_respuesta_ot` (desde su último cambio de estado). Severidad: «Crítico» si
//   alguno pasa del DOBLE del umbral; «Atención» si alguno pasa del umbral; si no, «ok».
// RN-TOR-O2 (carga): WIP (en curso, ver `EN_CURSO`) por organismo (Top 8) y por funcionario que envió el impuesto
//   (`enviado_por_id`); el segundo es `null` si ningún trámite en curso lo tiene.
// RN-TOR-O3 (comparativo de OT): creados en el rango por organismo; la mediana de respuesta va de la radicación (primera
//   vez en «Entregado»/«Enviado a OT») a la aprobación, en días.
// RN-TOR-O4 (logística): entregas = aprobados en el rango con logística liquidada; primer intento = sin viajes
//   adicionales (`flito_tramite_viajes_logistica`, `numero >= 2`). FLITO no registra la fecha de entrega final, así
//   que `tiempoMedioEntregaDias` sale `null` hasta que exista.
// RN-TOR-L1 (ADR-0044): el bloque de logística excluye las liquidaciones de trámites anulados/abortados/revocados
//   (`LIQUIDACION_VIGENTE`).
import { eq, sql } from 'drizzle-orm';
import type { CausaRadarTorre, SerieTorre, SeveridadTorre, TableroOperativo } from '@operaciones/shared-types';
import {
  flitoImpuestos, flitoLiquidaciones, flitoTramiteHistorial, flitoTramites, flitoTramiteViajesLogistica, users,
} from '../../db/schema.js';
import { contarSinGestion } from '../flito-tablero/flito-tablero.service.js';
import { EN_CURSO, FECHA_APROBACION, FECHA_CREACION, LIQUIDACION_VIGENTE } from './flito-torre.catalogo.js';
import { donde } from './flito-torre.filtro.js';
import { enTorre, nombreOrganismo, type Ejecutor } from './flito-torre.metricas.service.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';
import {
  conCacheTablero, condTramites, num, pct, pctONull, r1, rangoTablero, type ContextoTablero,
} from './flito-torre.tablero-comun.js';

const T = flitoTramites;
const H = flitoTramiteHistorial;
const ESTADOS_EN_OT = ['entregado', 'enviado a ot'];
const IGNORA_RADAR = ['rango'] as const;

const severidad = (sobreUmbral: number, sobreDoble: number): SeveridadTorre =>
  (sobreDoble > 0 ? 'critico' : sobreUmbral > 0 ? 'atencion' : 'ok');

type FilaRadar = TableroOperativo['radar']['filas'][number];

/** RN-TOR-O1. Compartido con el 360°. */
export async function calcularRadar(q: Ejecutor, ctx: ContextoTablero): Promise<FilaRadar[]> {
  const u = await valoresUmbrales();
  const horas = u.horas_soat_impuesto_sin_soporte;
  const [sobre, doble] = await Promise.all([
    contarSinGestion(horas, ctx.alcance, ctx.filtro.companiaIds),
    contarSinGestion(horas * 2, ctx.alcance, ctx.filtro.companiaIds),
  ]);
  const conds = condTramites(ctx, null, undefined, IGNORA_RADAR);
  const dB = u.dias_borrador_abandonado;
  const dOt = u.dias_respuesta_ot;
  const ultimoCambio = sql`COALESCE((SELECT max(${H.createdAt}) FROM ${H} WHERE ${H.tramiteId} = ${T.id} AND ${H.campo} = 'flit_estado'),
    COALESCE(${T.fechaCreacionFlit}, ${T.createdAt}))`;
  const creado = sql`COALESCE(${T.fechaCreacionFlit}, ${T.createdAt})`;
  const [f] = await q(sql`SELECT
      count(*) FILTER (WHERE lower(${T.flitEstado}) = 'borrador' AND ${creado} < now() - make_interval(days => ${dB}))::int AS b1,
      count(*) FILTER (WHERE lower(${T.flitEstado}) = 'borrador' AND ${creado} < now() - make_interval(days => ${dB * 2}))::int AS b2,
      count(*) FILTER (WHERE lower(${T.flitEstado}) IN ${ESTADOS_EN_OT} AND ${T.fechaAprobacion} IS NULL
        AND ${ultimoCambio} < now() - make_interval(days => ${dOt}))::int AS o1,
      count(*) FILTER (WHERE lower(${T.flitEstado}) IN ${ESTADOS_EN_OT} AND ${T.fechaAprobacion} IS NULL
        AND ${ultimoCambio} < now() - make_interval(days => ${dOt * 2}))::int AS o2
    FROM ${T} WHERE ${donde(conds)}`);
  const fila = (causa: CausaRadarTorre, etiqueta: string, cantidad: number, crit: number, umbral: number, unidad: 'horas' | 'dias'): FilaRadar =>
    ({ causa, etiqueta, cantidad, umbral, unidad, severidad: severidad(cantidad, crit) });
  return [
    fila('soat_sin_gestion', 'SOAT sin gestión', sobre.soat, doble.soat, horas, 'horas'),
    fila('impuesto_sin_gestion', 'Impuestos sin gestión', sobre.impuestos, doble.impuestos, horas, 'horas'),
    fila('borrador_abandonado', `Borradores de más de ${dB} días`, num(f?.b1), num(f?.b2), dB, 'dias'),
    fila('estancado_ot', `En el organismo hace más de ${dOt} días`, num(f?.o1), num(f?.o2), dOt, 'dias'),
  ];
}

async function carga(q: Ejecutor, ctx: ContextoTablero): Promise<TableroOperativo['carga'] & { wip: number }> {
  const conds = [EN_CURSO, ...condTramites(ctx, null, undefined, ['rango'])];
  const [w] = await q(sql`SELECT count(*)::int AS n FROM ${T} WHERE ${donde(conds)}`);
  const org = await q<{ k: string | null; n: number }>(sql`SELECT ${T.organismoCodigo} AS k, count(*)::int AS n
    FROM ${T} WHERE ${donde(conds)} GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 8`);
  const fun = await q<{ k: string; n: number }>(sql`SELECT ${users.name} AS k, count(DISTINCT ${T.id})::int AS n
    FROM ${flitoImpuestos} INNER JOIN ${T} ON ${eq(T.id, flitoImpuestos.tramiteId)} INNER JOIN ${users} ON ${eq(users.id, flitoImpuestos.enviadoPorId)}
    WHERE ${donde(conds)} GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 8`);
  const serie = (k: string | null, n: number, etiqueta: string): SerieTorre => ({ clave: k ?? 'sin', etiqueta, valor: num(n) });
  return {
    filtrosIgnorados: ['rango'], wip: num(w?.n),
    porOrganismo: org.map((o) => serie(o.k, o.n, nombreOrganismo(o.k))),
    porFuncionario: fun.length ? fun.map((o) => serie(o.k, o.n, o.k)) : null,
  };
}

async function benchmark(q: Ejecutor, ctx: ContextoTablero, rango: ReturnType<typeof rangoTablero>, umbralDias: number) {
  const filas = await q<{ k: string | null; vol: number; apr: number; rech: number; pend: number; med: string | null }>(sql`
    SELECT ${T.organismoCodigo} AS k, count(*)::int AS vol,
      count(*) FILTER (WHERE ${T.fechaAprobacion} IS NOT NULL)::int AS apr,
      count(*) FILTER (WHERE lower(${T.flitEstado}) = 'rechazado')::int AS rech,
      count(*) FILTER (WHERE ${EN_CURSO})::int AS pend,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${T.fechaAprobacion} - rad.en)) / 86400.0)
        FILTER (WHERE ${T.fechaAprobacion} IS NOT NULL AND rad.en IS NOT NULL) AS med
    FROM ${T} LEFT JOIN LATERAL (SELECT min(${H.createdAt}) AS en FROM ${H} WHERE ${H.tramiteId} = ${T.id}
      AND ${H.campo} = 'flit_estado' AND lower(${H.valorNuevo}) IN ${ESTADOS_EN_OT}) rad ON true
    WHERE ${donde(condTramites(ctx, rango, FECHA_CREACION))}
    GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 50`);
  return filas.map((f) => {
    const med = f.med == null ? null : r1(Number(f.med));
    return {
      organismoCodigo: f.k, organismo: nombreOrganismo(f.k), volumen: num(f.vol), pctAprobado: pct(num(f.apr), num(f.vol)),
      pctRechazado: pct(num(f.rech), num(f.vol)), pendientes: num(f.pend), medianaRespuestaDias: med,
      sobreUmbral: med != null && med > umbralDias,
    };
  });
}

async function logistica(q: Ejecutor, ctx: ContextoTablero, rango: ReturnType<typeof rangoTablero>): Promise<TableroOperativo['logistica']> {
  const V = flitoTramiteViajesLogistica;
  const [f] = await q(sql`SELECT count(*)::int AS entregas,
      count(*) FILTER (WHERE via.n = 0)::int AS primero,
      COALESCE(sum(via.n), 0)::int AS viajes
    FROM ${flitoLiquidaciones} INNER JOIN ${T} ON ${eq(T.id, flitoLiquidaciones.tramiteId)}
      CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM ${V} WHERE ${V.tramiteId} = ${T.id} AND ${V.numero} >= 2) via
    WHERE ${donde([sql`${T.fechaAprobacion} IS NOT NULL`, sql`${flitoLiquidaciones.valorLogistica} > 0`, LIQUIDACION_VIGENTE, ...condTramites(ctx, rango, FECHA_APROBACION)])}`);
  const entregas = num(f?.entregas);
  return {
    filtrosIgnorados: [], entregas, primerIntento: num(f?.primero), primerIntentoPct: pctONull(num(f?.primero), entregas),
    viajesAdicionales: num(f?.viajes), tiempoMedioEntregaDias: null,
  };
}

export async function tableroOperativo(ctx: ContextoTablero): Promise<TableroOperativo> {
  const rango = rangoTablero(ctx);
  const u = await valoresUmbrales();
  return conCacheTablero('operativa', ctx, () => enTorre(async (q) => {
    const radar = await calcularRadar(q, ctx);
    const { wip, ...cargaBloque } = await carga(q, ctx);
    const bench = await benchmark(q, ctx, rango, u.dias_respuesta_ot);
    const log = await logistica(q, ctx, rango);
    const de = (c: CausaRadarTorre) => radar.find((r) => r.causa === c)!.cantidad;
    return {
      rango, dineroVisible: ctx.dinero, generadoEn: new Date().toISOString(),
      cifras: {
        sinGestionFueraAns: de('soat_sin_gestion') + de('impuesto_sin_gestion'),
        borradoresAbandonados: de('borrador_abandonado'), wip, primerIntentoPct: log.primerIntentoPct,
      },
      radar: { filtrosIgnorados: [...IGNORA_RADAR], filas: radar },
      carga: cargaBloque,
      benchmarkOt: { filtrosIgnorados: [], umbralDias: u.dias_respuesta_ot, filas: bench },
      logistica: log,
    };
  }));
}
