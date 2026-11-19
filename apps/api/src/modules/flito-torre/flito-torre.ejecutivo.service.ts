// Torre de Control Gerencial (Épica #14590, UX §7.4) — Resumen 360°. No calcula nada propio: reusa las piezas de los
// tableros Comercial, Operativo y Financiero sobre el MES EN CURSO de Bogotá (el rango de la barra no aplica; el resto
// del filtro y el alcance sí).
//
// RN-TOR-E1 (scorecards): comercial = creados del mes y clientes en caída; operativo = % de aprobados del mes cuya
//   duración de creación a aprobación cabe en `dias_respuesta_ot` (solo con `fecha_creacion_flit`); financiero = margen
//   bruto y valor sin facturar del mes (solo con permiso de dinero).
// RN-TOR-E2 (proyección): aprobados por día del mes en curso; cierre proyectado = acumulado / días transcurridos × días
//   del mes. Se compara con el total del mes anterior y con `meta_mensual_aprobados` (0 = sin meta → `null`).
// RN-TOR-E3 (riesgos): fuga de clientes (crítico si la caída duplica el umbral), bolsas en atención o crítico, causas del
//   radar operativo fuera de umbral y trabajo sin facturar (atención). Orden: crítico primero y luego por impacto
//   (volumen o monto afectado). Se devuelven los 5 primeros.
import { sql } from 'drizzle-orm';
import type { RiesgoTorre, TableroEjecutivo } from '@operaciones/shared-types';
import { flitoTramites } from '../../db/schema.js';
import { calcularFuga } from './flito-torre.comercial.service.js';
import { FECHA_APROBACION, FECHA_CREACION, HORAS_CICLO } from './flito-torre.catalogo.js';
import { calcularBolsas, calcularMargen, calcularSinFacturar, margenTotalPct } from './flito-torre.financiera.service.js';
import { donde, fechaLocal, mesAnterior, resolverRango, type RangoResuelto } from './flito-torre.filtro.js';
import { explicarEjecutivo } from './flito-torre.frases.js';
import { enTorre, type Ejecutor } from './flito-torre.metricas.service.js';
import { calcularRadar } from './flito-torre.operativa.service.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';
import {
  conCacheTablero, condTramites, diasDe, hoyDe, num, pctONull, r1, type ContextoTablero,
} from './flito-torre.tablero-comun.js';

const T = flitoTramites;
const PESO: Record<RiesgoTorre['severidad'], number> = { critico: 0, atencion: 1 };

async function aprobadosPorDia(q: Ejecutor, ctx: ContextoTablero, rango: RangoResuelto): Promise<Map<number, number>> {
  const filas = await q<{ d: number; n: number }>(sql`SELECT EXTRACT(DAY FROM ${fechaLocal(FECHA_APROBACION)})::int AS d, count(*)::int AS n
    FROM ${T} WHERE ${donde([sql`${T.fechaAprobacion} IS NOT NULL`, ...condTramites(ctx, rango, FECHA_APROBACION)])} GROUP BY 1`);
  return new Map(filas.map((f) => [Number(f.d), num(f.n)]));
}

const acumulado = (porDia: Map<number, number>, dias: number) => {
  let s = 0;
  return Array.from({ length: dias }, (_, i) => { s += porDia.get(i + 1) ?? 0; return { dia: i + 1, valor: s }; });
};

/** RN-TOR-E3. Puro. */
export function ordenarRiesgos(riesgos: RiesgoTorre[], max = 5): RiesgoTorre[] {
  return [...riesgos].sort((a, b) => PESO[a.severidad] - PESO[b.severidad] || b.impacto - a.impacto).slice(0, max);
}

export async function tableroEjecutivo(ctx: ContextoTablero): Promise<TableroEjecutivo> {
  const hoy = hoyDe(ctx);
  const mes = resolverRango({ preset: 'mes' }, hoy);
  const anterior = mesAnterior(hoy);
  const u = await valoresUmbrales();
  return conCacheTablero('ejecutivo', ctx, () => enTorre(async (q) => {
    const condMes = (fecha = FECHA_CREACION) => condTramites({ ...ctx }, mes, fecha);
    const [creados] = await q(sql`SELECT count(*)::int AS n FROM ${T} WHERE ${donde(condMes())}`);
    const fuga = await calcularFuga(q, ctx, u.dias_ventana_fuga, u.pct_caida_volumen);

    const dentro = sql`${HORAS_CICLO} <= ${u.dias_respuesta_ot * 24}`;
    const [ans] = await q(sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE ${dentro})::int AS ok FROM ${T}
      WHERE ${donde([sql`${T.fechaAprobacion} IS NOT NULL`, sql`${T.fechaCreacionFlit} IS NOT NULL`, ...condMes(FECHA_APROBACION)])}`);

    const margen = await calcularMargen(q, ctx, mes);
    const sinFacturar = await calcularSinFacturar(q, ctx, mes);
    const bolsas = await calcularBolsas(q, ctx, u.dias_cobertura_rojo, u.dias_cobertura_amarillo);
    const radar = await calcularRadar(q, ctx);

    const actual = await aprobadosPorDia(q, ctx, mes);
    const previo = await aprobadosPorDia(q, ctx, anterior);
    const diasTranscurridos = Number(hoy.slice(8, 10));
    const diasMes = diasDe({ desde: mes.desde, hasta: new Date(Date.UTC(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)), 0)).toISOString().slice(0, 10) });
    const acum = acumulado(actual, diasTranscurridos);
    const llevado = acum.at(-1)?.valor ?? 0;
    const mesPrevio = acumulado(previo, diasDe(anterior));
    const totalMesAnterior = mesPrevio.at(-1)?.valor ?? 0;
    const proyeccionCierre = Math.round((llevado / diasTranscurridos) * diasMes);

    const riesgos: RiesgoTorre[] = [
      ...fuga.map((f) => ({
        area: 'comercial' as const, frase: `${f.compania} bajó ${Math.abs(f.variacionPct)} % frente a su promedio`,
        umbral: `atención desde ${u.pct_caida_volumen} %`,
        severidad: (-f.variacionPct >= u.pct_caida_volumen * 2 ? 'critico' : 'atencion') as RiesgoTorre['severidad'],
        impacto: Math.max(0, f.promedio - f.tramitesVentana),
      })),
      ...bolsas.filter((b) => b.severidad !== 'ok').map((b) => ({
        area: 'financiero' as const, frase: (b.diasCobertura ?? 0) <= 0
          ? `La bolsa de ${b.compania} está agotada`
          : `La bolsa de ${b.compania} alcanza para ${(b.diasCobertura ?? 0).toLocaleString('es-CO', { maximumFractionDigits: 1 })} días`,
        umbral: `crítico ${u.dias_cobertura_rojo} días`, severidad: b.severidad as RiesgoTorre['severidad'],
        impacto: b.consumoDiario ?? 0,
      })),
      ...radar.filter((r) => r.severidad !== 'ok').map((r) => ({
        area: 'operativo' as const, frase: `${r.cantidad} · ${r.etiqueta}`,
        umbral: `${r.umbral} ${r.unidad === 'horas' ? 'horas' : 'días'}`, severidad: r.severidad as RiesgoTorre['severidad'],
        impacto: r.cantidad,
      })),
    ];
    const sinFacturarN = sinFacturar.reduce((a, f) => a + f.tramites, 0);
    const sinFacturarValor = ctx.dinero ? sinFacturar.reduce((a, f) => a + (f.valorEstimado ?? 0), 0) : null;
    if (sinFacturarN > 0) {
      riesgos.push({
        area: 'financiero', frase: `${sinFacturarN} trámites aprobados este mes sin facturar`, umbral: 'cualquiera',
        severidad: 'atencion', impacto: sinFacturarValor ?? sinFacturarN,
      });
    }

    const sinExplicar: Omit<TableroEjecutivo, 'explicaciones'> = {
      rango: mes, dineroVisible: ctx.dinero, generadoEn: new Date().toISOString(),
      comercial: { tramitesMes: num(creados?.n), clientesEnCaida: fuga.length },
      operativo: { pctDentroAns: pctONull(num(ans?.ok), num(ans?.n)), umbralDias: u.dias_respuesta_ot },
      financiero: { margenPct: margenTotalPct(margen), sinFacturarValor },
      proyeccion: {
        mes: hoy.slice(0, 7), diasTranscurridos, diasMes, acumulado: acum, mesAnterior: mesPrevio,
        totalMesAnterior, proyeccionCierre,
        variacionPct: totalMesAnterior ? r1(((proyeccionCierre - totalMesAnterior) / totalMesAnterior) * 100) : null,
        meta: u.meta_mensual_aprobados > 0 ? u.meta_mensual_aprobados : null,
      },
      riesgos: ordenarRiesgos(riesgos),
    };
    return { ...sinExplicar, explicaciones: explicarEjecutivo(sinExplicar, u) };
  }));
}

