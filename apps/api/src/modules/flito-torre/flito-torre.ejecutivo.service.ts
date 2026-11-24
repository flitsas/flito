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
//   (volumen o monto afectado). Se devuelven los 5 primeros. (B6: la UI ya no lo pinta; se conserva en el DTO.)
// RN-TOR-E5 («Para hoy», B6): lista FIJA de frentes accionables de B1–B4 (`FRENTES_PARA_HOY`; B5/Equipo no aporta,
//   decisión UX). Se cuentan en UNA llamada a `contarConjuntos` (la misma cifra que el `total` del detalle de su
//   destino, RN-TOR-D1), solo si el usuario tiene la función del tablero de origen del frente (`area`) Y puede abrir el
//   conjunto (`funcionesOrigen`); «Clientes en caída», la función del Comercial. Entra el frente con cifra > 0. Gravedad: `doble` = crítico si alguno pasa del doble del
//   umbral (`severidad: critico`); `critico`/`atencion` fija; `segun` = crítico si el segmento declarado tiene alguno.
//   Cobertura crítica cuenta solo las bolsas CON saldo (`nivel: con_saldo`): las agotadas tienen su propio frente.
//   Foto de hoy, salvo `sin_facturar` = mes en curso. Orden: crítico → atención, y luego cifra descendente.
// RN-TOR-E4 (hallazgos): `hallazgosEjecutivo` (frases.ts) sobre el mes en curso frente a `periodoAnterior(mes)`.
import { sql } from 'drizzle-orm';
import {
  FUNCION_TABLERO_LOGISTICA_TORRE, FUNCION_TABLERO_PRODUCTOS_TORRE, conjuntoTorre,
  type ConjuntoTorreId, type FrenteTorre, type RiesgoTorre, type SegmentoDetalle, type TableroEjecutivo,
} from '@operaciones/shared-types';
import { flitoTramites } from '../../db/schema.js';
import { calcularFuga, concentracion, embudo, porCompania } from './flito-torre.comercial.service.js';
import { contarConjuntos, dondeFragmento, fragmentoConjunto, type Umbrales } from './flito-torre.conjuntos.js';
import { FECHA_APROBACION, FECHA_CREACION, HORAS_CICLO } from './flito-torre.catalogo.js';
import { calcularBolsas, calcularMargen, calcularSinFacturar, margenTotalPct } from './flito-torre.financiera.service.js';
import { donde, fechaLocal, mesAnterior, periodoAnterior, resolverRango, type RangoResuelto } from './flito-torre.filtro.js';
import { MILLONES, aConjunto, explicarEjecutivo, hallazgosEjecutivo, type DatosHallazgos } from './flito-torre.frases.js';
import { enTorre, nombresCompania, type Ejecutor } from './flito-torre.metricas.service.js';
import { calcularRadar } from './flito-torre.operativa.service.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';
import {
  conCacheTablero, condTramites, diasDe, hoyDe, num, pct, pctONull, r1, type ContextoTablero,
} from './flito-torre.tablero-comun.js';

const T = flitoTramites;
const PESO: Record<RiesgoTorre['severidad'], number> = { critico: 0, atencion: 1 };

const COMERCIAL = 'torre.tablero_comercial.ver';
const FINANCIERO = 'torre.tablero_financiero.ver';
const OPERATIVO = 'torre.tablero_operativo.ver';
const PRODUCTOS = FUNCION_TABLERO_PRODUCTOS_TORRE;
const LOGISTICA = FUNCION_TABLERO_LOGISTICA_TORRE;
const CRITICO: SegmentoDetalle[] = [{ dimension: 'severidad', valores: ['critico'] }];

const pl = (n: number, uno: string, varios: string): string => (n === 1 ? uno : varios);

/** Lo que una frase necesita además de la cifra. */
export interface ExtraFrente { u: Umbrales; sinFacturarValor: number | null; otrasBolsas: boolean; bolsaMasBaja: string | null }

export interface FrenteDef {
  conjunto: ConjuntoTorreId;
  /** La función del tablero de origen del frente (UX B6.2): sin ella no entra, aunque el conjunto se pudiera abrir. */
  area: string;
  segmentos?: SegmentoDetalle[];
  /** `doble` = RN-TOR-D3; `segun` = crítico si `criticoSi` tiene alguno. */
  gravedad: 'doble' | 'critico' | 'atencion' | 'segun';
  criticoSi?: SegmentoDetalle[];
  /** `sin_facturar`: rango del mes en curso. */
  mes?: boolean;
  frase: (n: number, x: ExtraFrente) => string;
}

/** RN-TOR-E5 (UX B6.2): los frentes candidatos, en el orden de la tabla. */
export const FRENTES_PARA_HOY: readonly FrenteDef[] = [
  { conjunto: 'soat_sin_gestion', area: OPERATIVO, gravedad: 'doble',
    frase: (n, { u }) => `${pl(n, 'gestión de SOAT lleva', 'gestiones de SOAT llevan')} más de ${u.horas_soat_impuesto_sin_soporte} horas sin soporte.` },
  { conjunto: 'impuesto_sin_gestion', area: OPERATIVO, gravedad: 'doble',
    frase: (n, { u }) => `${pl(n, 'gestión de impuestos lleva', 'gestiones de impuestos llevan')} más de ${u.horas_soat_impuesto_sin_soporte} horas sin soporte.` },
  { conjunto: 'borrador_abandonado', area: OPERATIVO, gravedad: 'doble',
    frase: (n, { u }) => `${pl(n, 'trámite lleva', 'trámites llevan')} más de ${u.dias_borrador_abandonado} días en Borrador.` },
  { conjunto: 'estancado_ot', area: OPERATIVO, gravedad: 'doble',
    frase: (n, { u }) => `${pl(n, 'trámite lleva', 'trámites llevan')} en el organismo más de ${u.dias_respuesta_ot} días.` },
  { conjunto: 'sin_facturar', area: FINANCIERO, gravedad: 'atencion', mes: true,
    frase: (n, { sinFacturarValor: v }) => `${pl(n, 'trámite aprobado este mes aún no tiene factura', 'trámites aprobados este mes aún no tienen factura')}${v != null && v > 0 ? ` (${MILLONES(v)})` : ''}.` },
  { conjunto: 'soat_por_vencer', area: PRODUCTOS, gravedad: 'segun', criticoSi: CRITICO,
    frase: (n, { u }) => `${pl(n, 'SOAT vence', 'SOAT vencen')} en los próximos ${u.dias_soat_por_vencer} días.` },
  { conjunto: 'soat_vigencia_no_verificada', area: PRODUCTOS, gravedad: 'atencion',
    frase: (n) => `SOAT aún no ${pl(n, 'tiene', 'tienen')} la vigencia verificada.` },
  { conjunto: 'soat_incompletas_abiertas', area: PRODUCTOS, gravedad: 'atencion',
    frase: (n) => `${pl(n, 'solicitud de SOAT sigue incompleta', 'solicitudes de SOAT siguen incompletas')}.` },
  { conjunto: 'impuestos_con_diferencia', area: PRODUCTOS, gravedad: 'atencion',
    frase: (n) => `${pl(n, 'impuesto tiene', 'impuestos tienen')} diferencia entre lo liquidado y lo pagado.` },
  { conjunto: 'impuestos_direccion_pendiente', area: PRODUCTOS, gravedad: 'atencion',
    frase: (n) => `${pl(n, 'impuesto espera', 'impuestos esperan')} revisión de la dirección.` },
  { conjunto: 'derechos_pendientes_sin_resolver', area: PRODUCTOS, gravedad: 'atencion',
    frase: (n) => `${pl(n, 'pago de derechos sigue', 'pagos de derechos siguen')} sin asociarse a un trámite.` },
  { conjunto: 'traslados_abiertos_mas_de_n', area: LOGISTICA, gravedad: 'doble',
    frase: (n, { u }) => `${pl(n, 'traslado lleva abierto', 'traslados llevan abiertos')} más de ${u.dias_traslado_abierto} días.` },
  { conjunto: 'actas_pendientes_entrega', area: LOGISTICA, gravedad: 'atencion',
    frase: (n) => `${pl(n, 'acta sigue pendiente', 'actas siguen pendientes')} de entrega.` },
  { conjunto: 'facturas_rechazadas_dian', area: FINANCIERO, gravedad: 'critico',
    frase: (n) => `${pl(n, 'factura fue rechazada', 'facturas fueron rechazadas')} por la DIAN.` },
  { conjunto: 'cola_facturacion_atascada', area: FINANCIERO, gravedad: 'segun', criticoSi: [{ dimension: 'nivel', valores: ['agotado'] }],
    frase: (n) => `${pl(n, 'trámite está detenido', 'trámites están detenidos')} en la cola de facturación.` },
  { conjunto: 'facturas_con_error', area: FINANCIERO, gravedad: 'atencion',
    frase: (n) => `${pl(n, 'factura tiene un error de Siigo o está', 'facturas tienen un error de Siigo o están')} en revisión.` },
  { conjunto: 'bolsas_cobertura', area: FINANCIERO, gravedad: 'critico',
    segmentos: [...CRITICO, { dimension: 'nivel', valores: ['con_saldo'] }],
    frase: (n, { u, otrasBolsas, bolsaMasBaja }) => `${otrasBolsas ? pl(n, 'otra ', 'otras ') : ''}${pl(n, 'bolsa alcanza', 'bolsas alcanzan')} para menos de ${u.dias_cobertura_rojo} días${bolsaMasBaja ? `; la más baja, ${bolsaMasBaja}` : ''}.` },
  { conjunto: 'bolsas_agotadas', area: FINANCIERO, gravedad: 'critico',
    frase: (n) => `${pl(n, 'bolsa activa está', 'bolsas activas están')} sin saldo.` },
  { conjunto: 'boletas_con_diferencia', area: FINANCIERO, gravedad: 'atencion',
    frase: (n) => `${pl(n, 'boleta de pago al organismo tiene', 'boletas de pago al organismo tienen')} diferencia con lo cruzado.` },
];

const puedeAbrir = (c: ConjuntoTorreId, funciones: ReadonlySet<string>): boolean =>
  conjuntoTorre(c).funcionesOrigen.some((f) => funciones.has(f));

/** RN-TOR-E5. Puro: ordena crítico → atención y luego por cifra. */
export function ordenarFrentes(frentes: FrenteTorre[]): FrenteTorre[] {
  return [...frentes].sort((a, b) => PESO[a.severidad] - PESO[b.severidad] || b.cifra - a.cifra);
}

export interface ExtraParaHoy { sinFacturarValor: number | null; bolsaMasBaja: string | null; clientesEnCaida: number }

/** RN-TOR-E5: UNA llamada a `contarConjuntos` con los frentes que el usuario puede abrir. */
export async function calcularParaHoy(q: Ejecutor, ctx: ContextoTablero, u: Umbrales, x: ExtraParaHoy): Promise<FrenteTorre[]> {
  const funciones = ctx.funciones ?? new Set<string>();
  const defs = FRENTES_PARA_HOY.filter((d) => funciones.has(d.area) && puedeAbrir(d.conjunto, funciones));
  const ctxMes: ContextoTablero = { ...ctx, filtro: { ...ctx.filtro, rango: { preset: 'mes' } } };
  const crit = (d: FrenteDef) => (d.gravedad === 'doble' ? CRITICO : d.gravedad === 'segun' ? d.criticoSi : undefined);
  const k = defs.length ? await contarConjuntos(q, ctxMes, u, defs.flatMap((d) => {
    const c = crit(d);
    return [
      { clave: d.conjunto, conjunto: d.conjunto, segmentos: d.segmentos },
      ...(c ? [{ clave: `${d.conjunto}:critico`, conjunto: d.conjunto, segmentos: [...(d.segmentos ?? []), ...c] }] : []),
    ];
  })) : {};
  const extra: ExtraFrente = {
    u, sinFacturarValor: ctx.dinero ? x.sinFacturarValor : null, bolsaMasBaja: x.bolsaMasBaja,
    otrasBolsas: num(k.bolsas_agotadas) > 0,
  };
  const frentes: FrenteTorre[] = defs.filter((d) => num(k[d.conjunto]) > 0).map((d) => {
    const n = num(k[d.conjunto]);
    const severidad = d.gravedad === 'critico' || (crit(d) && num(k[`${d.conjunto}:critico`]) > 0) ? 'critico' as const : 'atencion' as const;
    return {
      clave: d.conjunto, conjunto: d.conjunto, cifra: n, frase: d.frase(n, extra), severidad, accion: 'ver' as const,
      destino: aConjunto(d.conjunto, d.segmentos), rango: d.mes ? { preset: 'mes' as const } : null,
    };
  });
  // «Clientes en caída» no es un conjunto: «Revisar» lleva al bloque del Comercial (con su función).
  if (funciones.has(COMERCIAL) && x.clientesEnCaida > 0) {
    frentes.push({
      clave: 'fuga', conjunto: null, cifra: x.clientesEnCaida, severidad: 'atencion', accion: 'revisar',
      frase: `${pl(x.clientesEnCaida, 'compañía creó', 'compañías crearon')} al menos ${u.pct_caida_volumen} % menos trámites que su promedio.`,
      destino: { tipo: 'bloque', bloque: 'fuga' }, rango: null,
    });
  }
  return ordenarFrentes(frentes);
}

const conRango = (ctx: ContextoTablero, r: RangoResuelto): ContextoTablero => ({ ...ctx, filtro: { ...ctx.filtro, rango: { desde: r.desde, hasta: r.hasta } } });

/** RN-TOR-E4: los números de cada regla, solo de los tableros que el usuario ve. */
export async function datosHallazgos(q: Ejecutor, ctx: ContextoTablero, u: Umbrales, mes: RangoResuelto): Promise<DatosHallazgos> {
  const f = ctx.funciones ?? new Set<string>();
  const ant = periodoAnterior(mes);
  const [cm, ca] = [conRango(ctx, mes), conRango(ctx, ant)];
  const d: DatosHallazgos = {};
  if (f.has(COMERCIAL)) {
    const [em, ea] = [await embudo(q, cm, u), await embudo(q, ca, u)];
    const fc = fragmentoConjunto('tramites_creados', cm, u);
    const volumen = await porCompania(q, fc.desde, sql`count(*)`, [dondeFragmento(fc)]);
    const ids = volumen.map((v) => v.id).filter((id): id is number => id != null);
    const conc = concentracion(volumen, await nombresCompania(q, ids));
    const mayor = conc.top[0];
    d.creados = {
      actual: em[0]!.valor, anterior: ea[0]!.valor, top3Pct: conc.total ? conc.top3Pct : null,
      companias: volumen.length, mayor: mayor?.compania ?? null, mayorPct: mayor?.pct ?? null,
    };
    d.conversion = {
      actual: em[0]!.valor ? pct(em[3]!.valor, em[0]!.valor) : null, anterior: ea[0]!.valor ? pct(ea[3]!.valor, ea[0]!.valor) : null,
    };
  }
  if (f.has(FINANCIERO)) {
    const [sm, sa] = [await calcularSinFacturar(q, ctx, mes), await calcularSinFacturar(q, ctx, ant)];
    const total = (xs: typeof sm) => xs.reduce((a, x) => a + x.tramites, 0);
    const valor = (xs: typeof sm) => (ctx.dinero ? xs.reduce((a, x) => a + (x.valorEstimado ?? 0), 0) : null);
    d.sinFacturar = { actual: total(sm), anterior: total(sa), valorActual: valor(sm), valorAnterior: valor(sa) };
  }
  if (f.has(FUNCION_TABLERO_LOGISTICA_TORRE)) {
    const primer: SegmentoDetalle[] = [{ dimension: 'nivel', valores: ['primer_intento'] }];
    const pedidos = [{ clave: 'e', conjunto: 'entregas_logistica' as const }, { clave: 'p', conjunto: 'entregas_logistica' as const, segmentos: primer }];
    const [km, ka] = [await contarConjuntos(q, cm, u, pedidos), await contarConjuntos(q, ca, u, pedidos)];
    d.primerIntento = { actual: pctONull(num(km.p), num(km.e)), anterior: pctONull(num(ka.p), num(ka.e)) };
  }
  if (f.has(FUNCION_TABLERO_PRODUCTOS_TORRE)) {
    const pedidos = [{ clave: 's', conjunto: 'soat_pagados_periodo' as const }, { clave: 'i', conjunto: 'impuestos_pagados_periodo' as const }];
    const [km, ka] = [await contarConjuntos(q, cm, u, pedidos), await contarConjuntos(q, ca, u, pedidos)];
    d.pagados = { soat: { actual: num(km.s), anterior: num(ka.s) }, impuestos: { actual: num(km.i), anterior: num(ka.i) } };
  }
  return d;
}

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
  // B6: «Para hoy» y los hallazgos dependen de las operaciones del usuario: entran en la clave de caché.
  const nombreCache = `ejecutivo:${[...(ctx.funciones ?? [])].sort().join(',')}`;
  return conCacheTablero(nombreCache, ctx, () => enTorre(async (q) => {
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
      paraHoy: await calcularParaHoy(q, ctx, u, {
        sinFacturarValor, clientesEnCaida: fuga.length,
        bolsaMasBaja: bolsas.filter((b) => b.severidad === 'critico' && (b.diasCobertura ?? 0) > 0)
          .sort((a, b) => (a.diasCobertura ?? 0) - (b.diasCobertura ?? 0))[0]?.compania ?? null,
      }),
      hallazgos: hallazgosEjecutivo(await datosHallazgos(q, ctx, u, mes)),
    };
    return { ...sinExplicar, explicaciones: explicarEjecutivo(sinExplicar, u) };
  }));
}

