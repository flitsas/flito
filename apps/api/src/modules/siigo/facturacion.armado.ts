// Cómo se arma la factura que se le envía a Siigo (HU #11325, Feature #11242).
//
// **Función pura, sin base de datos.** Recibe la liquidación, el mapeo ya resuelto, la
// configuración y el tercero —identificación y sucursal— como parámetros. Dos motivos:
//
//   1. Se puede probar el armado entero sin levantar nada, y estas son las pruebas que importan:
//      lo que sale de aquí es un documento ante la DIAN.
//   2. No depende de la tabla de terceros, que es de la HU #11297 y todavía no existe. Que el
//      armador esté escrito antes que ella no es casualidad: son dos preguntas separables.
//
// **Ninguna decisión de negocio está escrita aquí.** Todas las que siguen abiertas —el GMF, la
// forma de pago, las retenciones, la moneda, la numeración, la sucursal— entran como dato. Si al
// leer este archivo aparece un literal que responde una de esas preguntas, es un error.

import { createHash } from 'node:crypto';
import {
  CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION,
  CONCEPTO_FACTURABLE_LABEL,
  SIIGO_IDEMPOTENCY_KEY_MAX,
  SIIGO_IDEMPOTENCY_KEY_RE,
  type ConceptoFacturable,
  type ValoresLiquidacion,
} from '@operaciones/shared-types';
import type { MapeoConcepto } from './mapeo-conceptos.service.js';
import { conceptosAplicables } from './siigo.compuerta.service.js';

// ── Lo que el armador necesita saber ────────────────────────────────────────

/** El tercero YA resuelto. La sucursal sale del vínculo con Siigo, nunca de un cero escrito aquí. */
export interface TerceroResuelto {
  identificacion: string;
  sucursal: number;
}

/** Un trámite con lo suyo: sus valores sellados y los datos que van a las observaciones. */
export interface TramiteFacturable {
  tramiteId: string;
  /** Identificador FLIT visible, el que usa la operación para hablar del trámite. */
  idFlit: string;
  placa: string | null;
  tipoTramite: string | null;
  liquidacion: ValoresLiquidacion;
}

/** La parametrización vigente. Todo dato, ninguna suposición. */
export interface ParametrosEmision {
  documentoTipoCodigo: string;
  vendedorCodigo: string;
  formaPagoCodigo: string;
  centroCostoCodigo: string | null;
  /** Días. Cero significa de contado: es una afirmación, no un hueco. */
  plazoVencimientoDias: number;
  moneda: string;
  /** Mientras valga `'ninguna'` no se envía `retentions[]`. Pregunta 7, abierta. */
  retencionesEstrategia: string;
  /** `'siigo'` = el consecutivo lo asigna Siigo y NUNCA se envía `number`. Pregunta 12. */
  estrategiaNumeracion: string;
}

/** El mapeo resuelto de cada concepto que aparece en el grupo. */
export type MapeoPorConcepto = Partial<Record<ConceptoFacturable, MapeoConcepto>>;

export interface EntradaArmado {
  tramites: TramiteFacturable[];
  tercero: TerceroResuelto;
  parametros: ParametrosEmision;
  mapeo: MapeoPorConcepto;
  /** Fecha del documento, `yyyy-MM-dd`. Se recibe: el armador no lee el reloj. */
  fecha: string;
}

// ── Lo que sale ─────────────────────────────────────────────────────────────

export interface LineaFactura {
  code: string;
  description: string;
  quantity: number;
  price: number;
  taxes?: { id: number }[];
}

export interface FacturaArmada {
  document: { id: number };
  date: string;
  customer: { identification: string; branch_office: number };
  seller: number;
  items: LineaFactura[];
  payments: { id: number; value: number; due_date?: string }[];
  observations: string;
  currency: { code: string };
  cost_center?: number;
  stamp: { send: boolean };
  mail: boolean;
  /** Solo para trazabilidad interna; no viaja a Siigo. */
  _total: number;
}

export type MotivoRechazoArmado =
  | 'concepto_sin_mapeo'
  | 'concepto_sin_producto'
  | 'sin_lineas'
  | 'total_no_positivo'
  | 'importe_negativo'
  | 'parametro_no_numerico'
  | 'grupo_vacio';

export class FacturaNoArmableError extends Error {
  constructor(
    public readonly motivo: MotivoRechazoArmado,
    mensaje: string,
    public readonly detalle?: string,
  ) {
    super(mensaje);
    this.name = 'FacturaNoArmableError';
  }
}

// ── Idempotencia (AC6) ──────────────────────────────────────────────────────

/**
 * Deriva la clave de idempotencia de la identidad del lote.
 *
 * **El id del lote no sirve tal cual**: un UUID lleva guiones y 36 caracteres, y el contrato de
 * Siigo exige alfanumérico de hasta 30 sin especiales — `siigo.client.ts` lo rechaza antes de salir
 * a la red. Se deriva con un resumen truncado.
 *
 * Determinista y **nunca aleatoria**: es lo único que impide que un reintento produzca una segunda
 * factura ante la DIAN. Calcularla dos veces sobre el mismo lote da lo mismo, por construcción.
 */
export function claveIdempotencia(ambiente: string, huellaLote: string): string {
  const clave = createHash('sha256')
    .update(`${ambiente}|${huellaLote}`)
    .digest('hex')
    .slice(0, SIIGO_IDEMPOTENCY_KEY_MAX);
  /* c8 ignore next 3 -- un sha256 hex truncado siempre cumple; la guarda es por si el algoritmo
     cambia algún día y nadie recuerda el contrato. */
  if (!SIIGO_IDEMPOTENCY_KEY_RE.test(clave)) {
    throw new FacturaNoArmableError('parametro_no_numerico', `Clave de idempotencia inválida: ${clave}`);
  }
  return clave;
}

/**
 * Huella del conjunto de trámites: sha256 de sus ids **ordenados**.
 *
 * Ordenados para que el orden de selección en la pantalla no produzca lotes distintos con
 * exactamente el mismo contenido — que sería la misma carrera de dos facturas por un trámite, solo
 * que provocada por dónde hizo clic quien factura.
 */
export function huellaDeTramites(tramiteIds: string[]): string {
  return createHash('sha256').update([...tramiteIds].sort().join('|')).digest('hex');
}

// ── Armado ──────────────────────────────────────────────────────────────────

/** Convierte a número lo que llega como cadena desde `numeric`, sin tragarse un valor sucio. */
function aNumero(valor: string | number, campo: string): number {
  const n = typeof valor === 'number' ? valor : Number(valor);
  if (!Number.isFinite(n)) {
    throw new FacturaNoArmableError(
      'parametro_no_numerico', `El valor de ${campo} no es un número: ${String(valor)}`,
    );
  }
  return n;
}

/**
 * Las líneas de un trámite (AC2, AC3, AC4).
 *
 * Una por cada concepto que APLICA. `conceptosAplicables` ya sostiene la distinción que importa:
 * `null` significa que el concepto no aplica al trámite y `'0.00'` que aplica y vale cero. Un
 * concepto en cero **sí** genera línea; que la contabilidad vea un cero explícito es distinto de
 * que no vea nada.
 */
function lineasDe(tramite: TramiteFacturable, mapeo: MapeoPorConcepto): LineaFactura[] {
  const lineas: LineaFactura[] = [];

  for (const concepto of conceptosAplicables(tramite.liquidacion)) {
    const m = mapeo[concepto];
    if (!m) {
      throw new FacturaNoArmableError(
        'concepto_sin_mapeo',
        `El concepto ${CONCEPTO_FACTURABLE_LABEL[concepto]} no está mapeado a un producto de Siigo.`,
        concepto,
      );
    }
    if (!m.codigoProducto) {
      throw new FacturaNoArmableError(
        'concepto_sin_producto',
        `El concepto ${CONCEPTO_FACTURABLE_LABEL[concepto]} no tiene código de producto en Siigo.`,
        concepto,
      );
    }

    // AC4 — el GMF no tiene rama propia. Si el mapeo dice que no va como línea propia, no la
    // genera; y mientras `lineaPropiaPendiente` siga marcado, la compuerta impide emitir en real.
    // Escribir aquí un `if (concepto === 'gmf')` sería justamente responder la pregunta 5.
    if (!m.facturaLineaPropia) continue;

    const valor = tramite.liquidacion[CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION[concepto]];
    const price = aNumero(valor as string, `${concepto} del trámite ${tramite.idFlit}`);
    if (price < 0) {
      throw new FacturaNoArmableError(
        'importe_negativo',
        `El concepto ${CONCEPTO_FACTURABLE_LABEL[concepto]} tiene un importe negativo.`,
        `${tramite.idFlit}: ${price}`,
      );
    }

    lineas.push({
      code: m.codigoProducto,
      description: m.nombreProducto ?? CONCEPTO_FACTURABLE_LABEL[concepto],
      quantity: 1,
      price,
      ...(m.impuestos.length > 0
        ? { taxes: m.impuestos.map((i) => ({ id: aNumero(i.id, 'id de impuesto') })) }
        : {}),
    });
  }

  return lineas;
}

/**
 * Observaciones con trazabilidad (AC7).
 *
 * El identificador FLIT, la placa y el tipo de trámite. Es lo que permite reconciliar una factura
 * con su trámite cuando el `UPDATE` local falló pero el `POST` a Siigo sí llegó — y también lo que
 * lee una persona en Siigo Nube cuando alguien pregunta de qué es esta factura.
 */
function observacionesDe(tramites: TramiteFacturable[]): string {
  const lineas = tramites.map((t) => {
    const partes = [t.idFlit];
    if (t.placa) partes.push(`placa ${t.placa}`);
    if (t.tipoTramite) partes.push(t.tipoTramite);
    return partes.join(' · ');
  });
  return `FLITO · ${lineas.join(' | ')}`.slice(0, 4000);
}

/** Suma el plazo a la fecha del documento. `yyyy-MM-dd` en, `yyyy-MM-dd` fuera. */
export function fechaVencimiento(fecha: string, plazoDias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plazoDias);
  return d.toISOString().slice(0, 10);
}

/**
 * Arma la factura de UN grupo de trámites (AC1).
 *
 * Funciona igual con un grupo de uno que con uno de varios: **no hay ningún condicional sobre la
 * cantidad**. Es lo que permitirá habilitar la facturación consolidada añadiendo un agrupador y
 * nada más.
 */
export function armarFactura(entrada: EntradaArmado): FacturaArmada {
  const { tramites, tercero, parametros, mapeo, fecha } = entrada;

  if (tramites.length === 0) {
    throw new FacturaNoArmableError('grupo_vacio', 'No hay trámites que facturar en este grupo.');
  }

  const items = tramites.flatMap((t) => lineasDe(t, mapeo));
  if (items.length === 0) {
    throw new FacturaNoArmableError(
      'sin_lineas', 'Ningún concepto del grupo genera una línea de factura.',
    );
  }

  // AC7 — validación de sanidad AUNQUE los valores vengan de una liquidación sellada. Defensa en
  // profundidad: una liquidación corrupta no puede producir una factura ante la DIAN.
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  if (!(total > 0)) {
    throw new FacturaNoArmableError(
      'total_no_positivo', `El total de la factura no es mayor que cero: ${total}`,
    );
  }

  // AC5 — EXACTAMENTE UNA forma de pago. Siigo no admite más de una cuando maneja vencimiento, así
  // que enviar dos no es «más información»: es una factura rechazada.
  const pago: FacturaArmada['payments'][number] = {
    id: aNumero(parametros.formaPagoCodigo, 'forma de pago'),
    value: total,
  };
  // Plazo cero significa DE CONTADO, y de contado no lleva vencimiento. Enviar `due_date` igual a
  // la fecha del documento diría otra cosa.
  if (parametros.plazoVencimientoDias > 0) {
    pago.due_date = fechaVencimiento(fecha, parametros.plazoVencimientoDias);
  }

  const factura: FacturaArmada = {
    document: { id: aNumero(parametros.documentoTipoCodigo, 'tipo de comprobante') },
    date: fecha,
    customer: { identification: tercero.identificacion, branch_office: tercero.sucursal },
    seller: aNumero(parametros.vendedorCodigo, 'vendedor'),
    items,
    payments: [pago],
    observations: observacionesDe(tramites),
    // AC8 — la moneda es la configurada, no un literal escrito aquí.
    currency: { code: parametros.moneda },
    stamp: { send: true },
    mail: true,
    _total: total,
  };

  if (parametros.centroCostoCodigo) {
    factura.cost_center = aNumero(parametros.centroCostoCodigo, 'centro de costo');
  }

  // AC8 — lo que NO se envía, y por qué:
  //
  //   · `retentions[]` — mientras la estrategia sea `ninguna` (pregunta 7, abierta). Enviar un
  //     arreglo vacío no es lo mismo que no enviarlo, y no sabemos cuál de las dos quiere Siigo.
  //   · `number` — la estrategia de numeración configurada dice que el consecutivo lo asigna Siigo
  //     (pregunta 12). Enviarlo exigiría además que no exista ya en Nube.
  //
  // Si alguna de las dos preguntas se responde, esto deja de ser una omisión y pasa a ser una rama;
  // hasta entonces, omitir es la única opción que no afirma nada.
  return factura;
}

// ── Agrupadores (AC1) ───────────────────────────────────────────────────────

/**
 * Cómo se reparten los trámites en facturas.
 *
 * Hoy hay uno solo. Añadir el consolidado por cliente —decisión D-1, diferida— será **un agrupador
 * nuevo**, no un rediseño: el armador ya no distingue un grupo de uno de un grupo de varios.
 */
export type Agrupador = (tramites: TramiteFacturable[]) => TramiteFacturable[][];

/** Un grupo por trámite. La única estrategia admitida hoy. */
export const agrupadorPorTramite: Agrupador = (tramites) => tramites.map((t) => [t]);
