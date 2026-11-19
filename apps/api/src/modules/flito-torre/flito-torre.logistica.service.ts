// Torre de Control Gerencial (Épica #14590, B4) — Torre › Logística: Traslados · Entregas.
//
// RN-TOR-LO1 (B4-AC1, invariante): cada KPI, desglose y fila de tabla es un conjunto de `CONJUNTOS_TORRE` (con su
//   segmento) contado sobre el MISMO fragmento que lista el detalle; la cifra y el `total` del detalle no discrepan.
// RN-TOR-LO2: T1 «Traslados abiertos» = `traslados_por_estado` con `estado ∈ {registrado, en_ruta}`. El «entre N
//   orígenes y destinos» del UX (ⓡ1) no se dice: solo hay tres rutas posibles; va el desglose por ruta (sin destino).
// RN-TOR-LO3: E2 = `entregas_logistica` (B1) del periodo, partido por `nivel` (primer intento / con viajes).
// RN-TOR-LO4: solo conteos por estado, motivo y ruta; no proyecta datos del titular ni del mensajero: sin
//   `logPiiAccess` (regla 16). La etiqueta del motivo de devolución (texto libre) viaja solo en este body autenticado;
//   la clave de la fila y el segmento del destino son la clave opaca `claveMotivo` (RN-TOR-P4).
import { sql } from 'drizzle-orm';
import type { SegmentoDetalle, TableroLogistica } from '@operaciones/shared-types';
import { contarConjuntos, dondeFragmento, fragmentoConjunto, totalFragmento } from './flito-torre.conjuntos.js';
import { flitoLogisticaTraslados, flitoTramiteViajesLogistica } from '../../db/schema.js';
import { ESTADOS_TRASLADO_ABIERTO, ETIQUETA_RUTA, TRASLADO_ABIERTO } from './flito-torre.logistica-sql.js';
import { enTorre } from './flito-torre.metricas.service.js';
import { destino, kpi, tablaArea } from './flito-torre.productos.service.js';
import { conCacheTablero, num, pctONull, rangoTablero, type ContextoTablero } from './flito-torre.tablero-comun.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';

export const ESTADOS_TRASLADO = ['registrado', 'en_ruta', 'entregado', 'devuelto', 'anulado'] as const;
export const ETIQUETA_ESTADO_TRASLADO: Readonly<Record<string, string>> = {
  registrado: 'Registrado', en_ruta: 'En camino', entregado: 'Entregado', devuelto: 'Devuelto', anulado: 'Anulado',
};

/** `POST /tableros/logistica` (B4-AC1). */
export async function tableroLogistica(ctx: ContextoTablero): Promise<TableroLogistica> {
  const rango = rangoTablero(ctx);
  const u = await valoresUmbrales();
  return conCacheTablero('logistica', ctx, () => enTorre(async (q) => {
    const abiertos: SegmentoDetalle[] = [{ dimension: 'estado', valores: [...ESTADOS_TRASLADO_ABIERTO] }];
    const critico: SegmentoDetalle[] = [{ dimension: 'severidad', valores: ['critico'] }];
    const primer: SegmentoDetalle[] = [{ dimension: 'nivel', valores: ['primer_intento'] }];
    const conViajes: SegmentoDetalle[] = [{ dimension: 'nivel', valores: ['con_viajes'] }];
    const k = await contarConjuntos(q, ctx, u, [
      { clave: 'abiertos', conjunto: 'traslados_por_estado', segmentos: abiertos },
      { clave: 'masDeN', conjunto: 'traslados_abiertos_mas_de_n' },
      { clave: 'masDeNCrit', conjunto: 'traslados_abiertos_mas_de_n', segmentos: critico },
      { clave: 'pendientes', conjunto: 'actas_pendientes_entrega' },
      { clave: 'devueltas', conjunto: 'actas_devueltas_periodo' },
      { clave: 'entregas', conjunto: 'entregas_logistica' },
      { clave: 'primer', conjunto: 'entregas_logistica', segmentos: primer },
      { clave: 'conViajes', conjunto: 'entregas_logistica', segmentos: conViajes },
    ]);
    const fv = fragmentoConjunto('viajes_adicionales_periodo', ctx, u);
    const viajes = await totalFragmento(q, fv);
    const [tramites] = await q<{ n: number }>(sql`SELECT count(DISTINCT ${flitoTramiteViajesLogistica.tramiteId})::int AS n
      FROM ${fv.desde} WHERE ${dondeFragmento(fv)}`);
    // Abiertos por ruta: el mismo fragmento de `traslados_por_estado` + abiertos.
    const ft = fragmentoConjunto('traslados_por_estado', ctx, u);
    const TR = flitoLogisticaTraslados;
    const rutas = await q<{ o: string; d: string; n: number }>(sql`SELECT ${TR.origen} AS o, ${TR.destino} AS d, count(*)::int AS n
      FROM ${ft.desde} WHERE ${dondeFragmento(ft)} AND ${TRASLADO_ABIERTO} GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2`);
    const [tEstado, tDevueltas] = await Promise.all([
      tablaArea(q, ctx, u, 'traslados_por_estado', 'estado', 'Traslados por estado', false,
        { estados: ESTADOS_TRASLADO, etiquetasEstado: ETIQUETA_ESTADO_TRASLADO }),
      tablaArea(q, ctx, u, 'actas_devueltas_periodo', 'motivo', 'Actas devueltas en el periodo, por motivo', false),
    ]);

    const umbral = u.dias_traslado_abierto;
    const rutasAbiertas = rutas.map((r) => ({ origen: r.o, destino: r.d, etiqueta: ETIQUETA_RUTA(r.o, r.d), n: num(r.n) }));
    const comun = tDevueltas.filas.find((f) => f.clave !== '__otros');
    const nTramites = num(tramites?.n);
    return {
      traslados: {
        cifras: { abiertos: k.abiertos!, abiertosMasDeN: k.masDeN! },
        explicaciones: {
          abiertos: {
            ...kpi('traslados_por_estado', k.abiertos!, u),
            frase: k.abiertos ? `${k.abiertos} ${k.abiertos === 1 ? 'traslado sigue abierto' : 'traslados siguen abiertos'} hoy.` : 'No hay traslados abiertos.',
            destino: destino(k.abiertos!, 'traslados_por_estado', abiertos),
            desglose: rutasAbiertas.map((r) => ({ etiqueta: r.etiqueta, valor: r.n })),
          },
          abiertosMasDeN: {
            ...kpi('traslados_abiertos_mas_de_n', k.masDeN!, u),
            desglose: [{ etiqueta: `Más de ${umbral * 2} días`, valor: k.masDeNCrit!, destino: destino(k.masDeNCrit!, 'traslados_abiertos_mas_de_n', critico) }],
          },
        },
        tablas: [tEstado],
        rutasAbiertas,
        umbralDias: umbral,
      },
      entregas: {
        cifras: {
          pendientesEntrega: k.pendientes!, entregasPeriodo: k.entregas!, primerIntento: k.primer!,
          primerIntentoPct: pctONull(k.primer!, k.entregas!), devueltasPeriodo: k.devueltas!,
          viajesAdicionales: viajes.total, tramitesConViajes: nTramites,
        },
        explicaciones: {
          pendientesEntrega: kpi('actas_pendientes_entrega', k.pendientes!, u),
          entregasPeriodo: kpi('entregas_logistica', k.entregas!, u),
          primerIntento: {
            ...kpi('entregas_logistica', k.primer!, u),
            frase: k.entregas
              ? `De las ${k.entregas} entregas del periodo, ${k.primer} se hicieron al primer intento; ${k.conViajes} ${k.conViajes === 1 ? 'necesitó' : 'necesitaron'} otro viaje.`
              : 'No hubo entregas en el periodo.',
            destino: destino(k.primer!, 'entregas_logistica', primer),
            desglose: [{ etiqueta: 'Con otro viaje', valor: k.conViajes!, destino: destino(k.conViajes!, 'entregas_logistica', conViajes) }],
          },
          devueltasPeriodo: kpi('actas_devueltas_periodo', k.devueltas!, u, {
            cola: comun ? `El motivo más común: ${comun.etiqueta} (${comun.n}).` : undefined,
          }),
          viajesAdicionales: kpi('viajes_adicionales_periodo', viajes.total, u, {
            cola: viajes.total ? `En ${nTramites} ${nTramites === 1 ? 'trámite' : 'trámites'}.` : undefined,
          }),
        },
        tablas: [tDevueltas],
      },
      rango: { desde: rango.desde, hasta: rango.hasta },
      dineroVisible: ctx.dinero,
      generadoEn: new Date().toISOString(),
    };
  }));
}
