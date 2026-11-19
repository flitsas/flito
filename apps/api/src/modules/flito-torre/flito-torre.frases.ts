// Torre de Control Gerencial (Épica #14590, ADR-0047, UX §4.2) — las KPI que se explican: frase, definición y destino.
//
// Funciones PURAS sobre los números ya calculados por cada tablero (no consultan nada). La definición de cada cifra
// es SIEMPRE la del catálogo (`CONJUNTOS_TORRE` / `DEFINICIONES_BLOQUE_TORRE`) con los umbrales interpolados: aquí no
// se escribe ninguna definición. El destino lleva al conjunto (con su segmento) o al bloque ya visible (D3).
import {
  DEFINICIONES_BLOQUE_TORRE, conjuntoTorre, definicionConUmbral, fraseDeConjunto, textoConUmbrales,
  type CifraExplicada, type ComponenteCifra, type ConjuntoTorreId, type DestinoCifra, type SegmentoDetalle,
  type TableroComercial, type TableroEjecutivo, type TableroFinanciero, type TableroOperativo,
} from '@operaciones/shared-types';
import type { Umbrales } from './flito-torre.conjuntos.js';

const N = (n: number): string => n.toLocaleString('es-CO');
const P = (n: number): string => `${n.toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`;
const COP = (n: number): string => `$${Math.round(n).toLocaleString('es-CO')}`;
const plural = (n: number, uno: string, varios: string): string => (n === 1 ? uno : varios);

/** «A, B y C». */
export function enumerar(nombres: readonly string[], max = 3): string {
  const vis = nombres.slice(0, max);
  const resto = nombres.length - vis.length;
  if (resto > 0) return `${vis.join(', ')} y ${resto} más`;
  return vis.length <= 1 ? vis.join('') : `${vis.slice(0, -1).join(', ')} y ${vis.at(-1)}`;
}

export const aConjunto = (conjunto: ConjuntoTorreId, segmentos?: SegmentoDetalle[]): DestinoCifra =>
  ({ tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto }, ...(segmentos?.length ? { segmentos } : {}) });
const NINGUNO: DestinoCifra = { tipo: 'ninguno' };
const seg = (dimension: SegmentoDetalle['dimension'], valores: (string | null)[]): SegmentoDetalle[] => [{ dimension, valores }];

/** La definición del catálogo con su umbral resuelto. */
export function definicionDe(c: ConjuntoTorreId, u: Umbrales): string {
  const def = conjuntoTorre(c);
  return definicionConUmbral(def, def.umbral ? u[def.umbral] : undefined);
}

// ── Comercial ──────────────────────────────────────────────────────────────────────────────────────────

export function explicarComercial(t: Omit<TableroComercial, 'explicaciones'>, u: Umbrales): TableroComercial['explicaciones'] {
  const c = t.cifras;
  const pasos = Object.fromEntries(t.embudo.pasos.map((p) => [p.paso, p.valor])) as Record<'creados' | 'radicados' | 'aprobados' | 'facturados', number>;
  const top3 = t.concentracion.volumen.top.slice(0, 3);
  const caidas = t.fuga.filas;
  const componentesTop: ComponenteCifra[] = top3.map((p) => ({
    etiqueta: p.compania, valor: p.valor, pct: p.pct, destino: aConjunto('tramites_creados', seg('compania', [p.companiaId == null ? null : String(p.companiaId)])),
  }));
  return {
    clientesEnCaida: {
      frase: caidas.length
        ? `${N(caidas.length)} ${plural(caidas.length, 'compañía creó', 'compañías crearon')} al menos ${P(u.pct_caida_volumen)} menos trámites en los últimos ${u.dias_ventana_fuga} días que en su promedio: ${enumerar(caidas.map((f) => f.compania))}.`
        : 'Ninguna compañía está por debajo de su promedio.',
      definicion: textoConUmbrales(DEFINICIONES_BLOQUE_TORRE.fuga, u.dias_ventana_fuga, u.pct_caida_volumen),
      destino: caidas.length ? { tipo: 'bloque', bloque: 'fuga' } : NINGUNO,
      componentes: caidas.slice(0, 3).map((f) => ({
        etiqueta: f.compania, valor: f.tramitesVentana, pct: f.variacionPct, destino: aConjunto('tramites_creados', seg('compania', [String(f.companiaId)])),
      })),
    },
    concentracionTop3Pct: {
      frase: t.concentracion.volumen.total
        ? `${P(c.concentracionTop3Pct)} de los ${N(t.concentracion.volumen.total)} trámites creados en el periodo vienen de ${plural(top3.length, 'una compañía', `${top3.length} compañías`)}: ${enumerar(top3.map((p) => `${p.compania} (${P(p.pct)})`))}. Con las 5 más grandes: ${P(c.concentracionTop5Pct)}.`
        : 'No hay trámites creados en el periodo.',
      definicion: `${definicionDe('tramites_creados', u)} ${DEFINICIONES_BLOQUE_TORRE.concentracion}`,
      destino: top3.length ? aConjunto('tramites_creados', seg('compania', top3.map((p) => (p.companiaId == null ? null : String(p.companiaId))))) : NINGUNO,
      componentes: componentesTop,
    },
    conversionFacturadoPct: {
      frase: pasos.creados
        ? `De los ${N(pasos.creados)} trámites creados en el periodo, ${N(pasos.facturados)} ya están facturados. ${N(pasos.creados - pasos.aprobados)} siguen sin aprobar y ${N(Math.max(0, pasos.aprobados - pasos.facturados))} están aprobados sin factura.`
        : 'No hay trámites creados en el periodo.',
      definicion: definicionDe('facturados_cohorte', u),
      destino: pasos.facturados ? aConjunto('facturados_cohorte') : NINGUNO,
      desglose: [
        { etiqueta: 'Creados', valor: pasos.creados, destino: aConjunto('tramites_creados') },
        { etiqueta: 'Radicados', valor: pasos.radicados, destino: aConjunto('radicados_cohorte') },
        { etiqueta: 'Aprobados', valor: pasos.aprobados, destino: aConjunto('aprobados_cohorte') },
        { etiqueta: 'Facturados', valor: pasos.facturados, destino: aConjunto('facturados_cohorte') },
      ],
    },
    tramitesPeriodo: {
      frase: c.tramitesPeriodo
        ? `${N(c.tramitesPeriodo)} trámites creados en el periodo, ${N(Math.abs(c.tramitesPeriodo - c.tramitesPeriodoAnterior))} ${c.tramitesPeriodo >= c.tramitesPeriodoAnterior ? 'más' : 'menos'} que en el periodo anterior (${N(c.tramitesPeriodoAnterior)}).`
        : 'No se crearon trámites en el periodo.',
      definicion: DEFINICIONES_BLOQUE_TORRE.periodo_anterior,
      destino: c.tramitesPeriodo ? aConjunto('tramites_creados') : NINGUNO,
    },
  };
}

// ── Operativa ──────────────────────────────────────────────────────────────────────────────────────────

export interface ExtraOperativa { soatCriticas: number; impuestoCriticas: number; borradorCriticos: number; estancados: number }

export function explicarOperativa(t: Omit<TableroOperativo, 'explicaciones'>, u: Umbrales, x: ExtraOperativa): TableroOperativo['explicaciones'] {
  const de = (causa: string) => t.radar.filas.find((f) => f.causa === causa)?.cantidad ?? 0;
  const soat = de('soat_sin_gestion');
  const imp = de('impuesto_sin_gestion');
  const h = u.horas_soat_impuesto_sin_soporte;
  const dB = u.dias_borrador_abandonado;
  const c = t.cifras;
  const log = t.logistica;
  const reintentos = log.entregas - log.primerIntento;
  return {
    sinGestionFueraAns: {
      frase: c.sinGestionFueraAns
        ? `${N(c.sinGestionFueraAns)} ${plural(c.sinGestionFueraAns, 'gestión lleva', 'gestiones llevan')} más de ${h} horas sin soporte: ${N(soat)} de SOAT y ${N(imp)} de impuestos. ${N(x.soatCriticas + x.impuestoCriticas)} pasan de ${h * 2} horas.`
        : `Todas las gestiones de SOAT e impuestos tienen soporte dentro de ${h} horas.`,
      definicion: textoConUmbrales(DEFINICIONES_BLOQUE_TORRE.sin_gestion, h),
      destino: c.sinGestionFueraAns ? { tipo: 'bloque', bloque: 'radar' } : NINGUNO,
      desglose: [
        { etiqueta: 'SOAT', valor: soat, destino: aConjunto('soat_sin_gestion') },
        { etiqueta: 'Impuestos', valor: imp, destino: aConjunto('impuesto_sin_gestion') },
        { etiqueta: `Más de ${h * 2} horas`, valor: x.soatCriticas + x.impuestoCriticas },
      ],
    },
    borradoresAbandonados: {
      // La KPI ES el conjunto: su frase (llena y vacía) sale del catálogo, la misma del encabezado del detalle.
      frase: fraseDeConjunto(conjuntoTorre('borrador_abandonado'), c.borradoresAbandonados, dB, x.borradorCriticos),
      definicion: definicionDe('borrador_abandonado', u),
      destino: c.borradoresAbandonados ? aConjunto('borrador_abandonado') : NINGUNO,
      desglose: [{ etiqueta: `Más de ${dB * 2} días`, valor: x.borradorCriticos, destino: aConjunto('borrador_abandonado', seg('severidad', ['critico'])) }],
    },
    wip: {
      frase: c.wip
        ? `${N(c.wip)} trámites están en curso hoy; ${N(x.estancados)} llevan en el organismo más de ${u.dias_respuesta_ot} días.`
        : 'No hay trámites en curso.',
      definicion: definicionDe('en_curso', u),
      destino: c.wip ? aConjunto('en_curso') : NINGUNO,
      desglose: [{ etiqueta: `En el organismo más de ${u.dias_respuesta_ot} días`, valor: x.estancados, destino: aConjunto('estancado_ot') }],
    },
    primerIntentoPct: {
      frase: log.entregas
        ? `De las ${N(log.entregas)} entregas de trámites aprobados en el periodo, ${N(log.primerIntento)} se hicieron al primer intento; ${N(reintentos)} ${plural(reintentos, 'necesitó', 'necesitaron')} otro viaje.`
        : 'No hubo entregas en el periodo.',
      definicion: definicionDe('entregas_logistica', u),
      destino: reintentos > 0 ? aConjunto('entregas_logistica', seg('nivel', ['con_viajes'])) : NINGUNO,
      desglose: [
        { etiqueta: 'Al primer intento', valor: log.primerIntento, destino: aConjunto('entregas_logistica', seg('nivel', ['primer_intento'])) },
        { etiqueta: 'Con otro viaje', valor: reintentos, destino: aConjunto('entregas_logistica', seg('nivel', ['con_viajes'])) },
      ],
    },
  };
}

// ── Financiera ─────────────────────────────────────────────────────────────────────────────────────────

export function explicarFinanciera(t: Omit<TableroFinanciero, 'explicaciones'>, u: Umbrales): TableroFinanciero['explicaciones'] {
  const c = t.cifras;
  const m = c.menorCobertura;
  const enRiesgo = t.bolsas.filas.filter((b) => b.severidad !== 'ok').length;
  const menor = m ? t.bolsas.filas.find((b) => b.companiaId === m.companiaId) : undefined;
  const conc = t.conciliacion;
  const incompletos = conc.cero + conc.uno + conc.dos;
  const cobrado = t.margen?.porServicio.reduce((a, s) => a + s.cobrado, 0) ?? 0;
  const costo = t.margen?.porServicio.reduce((a, s) => a + (s.costo ?? 0), 0) ?? 0;
  const sinCosto = t.margen?.porServicio.filter((s) => s.sinCostoRegistrado).length ?? 0;
  const dineroBolsa = menor?.saldo != null && menor.consumoDiario != null ? ` (${COP(menor.saldo)} de saldo; ${COP(menor.consumoDiario)} al día)` : '';
  const masEnRiesgo = Math.max(0, enRiesgo - (m && m.severidad !== 'ok' ? 1 : 0));
  return {
    menorCobertura: {
      frase: m
        ? `La bolsa de ${m.compania} alcanza para ${N(m.dias)} días al ritmo de los últimos 30${dineroBolsa}. ${N(masEnRiesgo)} ${plural(masEnRiesgo, 'bolsa más está', 'bolsas más están')} en atención.`
        : 'Ninguna bolsa tiene consumo en los últimos 30 días.',
      definicion: textoConUmbrales(DEFINICIONES_BLOQUE_TORRE.bolsas, u.dias_cobertura_rojo, u.dias_cobertura_amarillo),
      destino: enRiesgo ? { tipo: 'bloque', bloque: 'bolsas' } : NINGUNO,
      desglose: [{ etiqueta: 'Bolsas en atención o críticas', valor: enRiesgo }],
    },
    sinFacturarTramites: {
      frase: c.sinFacturarTramites
        ? (c.sinFacturarValor != null
          ? `${COP(c.sinFacturarValor)} en ${N(c.sinFacturarTramites)} trámites aprobados en el periodo que aún no tienen factura.`
          : `${N(c.sinFacturarTramites)} trámites aprobados en el periodo aún no tienen factura.`)
        : 'Todo lo aprobado en el periodo ya está facturado.',
      definicion: definicionDe('sin_facturar', u),
      destino: c.sinFacturarTramites ? aConjunto('sin_facturar') : NINGUNO,
    },
    margenPct: t.margen == null
      ? { frase: 'Necesita permiso para ver dinero.', definicion: definicionDe('margen_aprobados', u), destino: NINGUNO }
      : {
        frase: cobrado
          ? `Del periodo se cobraron ${COP(cobrado)} y costaron ${COP(costo)}: queda el ${P(c.margenPct ?? 0)}.${sinCosto ? ` ${N(sinCosto)} ${plural(sinCosto, 'servicio no tiene', 'servicios no tienen')} costo registrado.` : ''}`
          : 'No hay trámites aprobados en el periodo.',
        definicion: definicionDe('margen_aprobados', u),
        destino: cobrado ? aConjunto('margen_aprobados') : NINGUNO,
        desglose: [
          { etiqueta: 'Cobrado', valor: cobrado }, { etiqueta: 'Costo', valor: costo },
          { etiqueta: 'Servicios sin costo registrado', valor: sinCosto },
        ],
      },
    soportesCompletosPct: {
      frase: conc.total
        ? `${N(conc.completos)} de los ${N(conc.total)} trámites aprobados en el periodo tienen sus 3 soportes: SOAT, impuesto y derecho. A ${N(incompletos)} les falta al menos uno.`
        : 'No hay trámites aprobados en el periodo.',
      definicion: definicionDe('soportes_aprobados', u),
      destino: incompletos ? aConjunto('soportes_aprobados', seg('nivel', ['0', '1', '2'])) : NINGUNO,
      desglose: [
        { etiqueta: '3 de 3', valor: conc.completos, destino: aConjunto('soportes_aprobados', seg('nivel', ['3'])) },
        { etiqueta: '2 de 3', valor: conc.dos, destino: aConjunto('soportes_aprobados', seg('nivel', ['2'])) },
        { etiqueta: '1 de 3', valor: conc.uno, destino: aConjunto('soportes_aprobados', seg('nivel', ['1'])) },
        { etiqueta: '0 de 3', valor: conc.cero, destino: aConjunto('soportes_aprobados', seg('nivel', ['0'])) },
      ],
    },
  };
}

// ── 360° ───────────────────────────────────────────────────────────────────────────────────────────────

export function explicarEjecutivo(t: Omit<TableroEjecutivo, 'explicaciones'>, u: Umbrales): Record<string, CifraExplicada> {
  return {
    'comercial.tramitesMes': {
      frase: t.comercial.tramitesMes ? `${N(t.comercial.tramitesMes)} trámites creados en lo que va del mes.` : 'No se han creado trámites este mes.',
      definicion: definicionDe('tramites_creados', u),
      destino: t.comercial.tramitesMes ? aConjunto('tramites_creados') : NINGUNO,
    },
    'comercial.clientesEnCaida': {
      frase: t.comercial.clientesEnCaida
        ? `${N(t.comercial.clientesEnCaida)} ${plural(t.comercial.clientesEnCaida, 'compañía está', 'compañías están')} por debajo de su promedio.`
        : 'Ninguna compañía está por debajo de su promedio.',
      definicion: textoConUmbrales(DEFINICIONES_BLOQUE_TORRE.fuga, u.dias_ventana_fuga, u.pct_caida_volumen),
      destino: NINGUNO,
    },
    'operativo.pctDentroAns': {
      frase: t.operativo.pctDentroAns == null ? 'No hay trámites aprobados este mes.'
        : `${P(t.operativo.pctDentroAns)} de los aprobados del mes se aprobaron dentro de ${t.operativo.umbralDias} días desde su creación.`,
      definicion: textoConUmbrales(DEFINICIONES_BLOQUE_TORRE.ans_aprobacion, t.operativo.umbralDias),
      destino: NINGUNO,
    },
    'financiero.sinFacturarValor': {
      frase: t.financiero.sinFacturarValor == null ? 'Necesita permiso para ver dinero.'
        : `${COP(t.financiero.sinFacturarValor)} aprobados este mes que aún no tienen factura.`,
      definicion: definicionDe('sin_facturar', u),
      destino: aConjunto('sin_facturar'),
    },
    'financiero.margenPct': {
      frase: t.financiero.margenPct == null ? 'Necesita permiso para ver dinero o no hay aprobados este mes.'
        : `El margen bruto del mes va en ${P(t.financiero.margenPct)}.`,
      definicion: definicionDe('margen_aprobados', u),
      destino: t.financiero.margenPct == null ? NINGUNO : aConjunto('margen_aprobados'),
    },
  };
}
