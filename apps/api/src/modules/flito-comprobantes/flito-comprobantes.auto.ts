// Comprobantes universales (Épica #12245, Feature #12606, ADR-0018 §4) — HU #12632: la AUTO-aplicación.
//
// D5 (cerrada): un comprobante que cruza con UN trámite y trae una lectura confiable se aplica solo,
// sin que nadie lo decida, y queda marcado (`aplicado_automaticamente = true`, `aplicado_por_id = NULL`,
// `aplicado_en = now`). Las condiciones son TODAS estas, en este orden (la primera que falla deja el
// comprobante `pendiente` con la sugerencia que la carga ya escribió: `tramite_id`, `cruce` y el
// `motivo_pendiente` de `columnasDeLectura`; aquí no se reescribe nada):
//   1. `COMPROBANTES_AUTO_APLICAR !== '0'` (ausente = encendida: interruptor de emergencia, no parámetro);
//   2. el cruce quedó FIJADO (único o desempatado) y ese candidato `admite[concepto] === 'admite'`;
//   3. `tipoDocumento`, `concepto`, `esComprobantePago` y `valorTotal` confiables con el umbral vigente
//      (`umbralPara`, el mismo del OCR: no hay parámetro nuevo), y `esComprobantePago = true` — la
//      automática solo PAGA; adjuntar documentación (`esPago = false`) sigue siendo una decisión humana;
//   4. en SOAT / impuesto / derecho, además, el veredicto del dueño aprobado (`evaluarExtraccionSoat` /
//      `evaluarReciboImpuesto` / `evaluarDerecho`) sobre la extracción especializada.
//
// Si se cumplen, entra por el MISMO `aplicar` (HU #12629/#12630/#12631) con `{ automatico: true }`:
// mismas guardas, mismo dueño, mismo cierre. El `ctx` es el de la persona que cargó (el soporte hijo y
// la auditoría del dueño necesitan un usuario real; la fila del comprobante es la que dice «automático»).
//
// Un fallo aquí (ComprobanteError o del dueño) NUNCA rompe la carga (AC3): el llamador lo captura por
// sub-documento, el comprobante queda `pendiente` con su sugerencia y el archivo ya persistido. Ningún
// log lleva contenido leído (Habeas Data): ids, conceptos, códigos.

import {
  CampoComprobante, ConceptoCosto, type CampoExtraido, type CandidatoTramiteDto, type ComprobanteDetalleDto,
  type ExtraccionDerechoTramite, type ExtraccionImpuesto, type ExtraccionSoat,
} from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { evaluarDerecho } from '../flito-derechos/flito-derechos.service.js';
import { evaluarReciboImpuesto } from '../flito-impuestos/flito-recibos.service.js';
import { umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { evaluarExtraccionSoat } from '../flito-soat/flito-soat.service.js';
import { aplicar, type AplicarBody } from './flito-comprobantes.aplicar.js';
import { type ResultadoCruce } from './flito-comprobantes.cruce.js';
import { type LecturaSubDocumento } from './flito-comprobantes.ocr.js';
import { columnasDeLectura, ComprobanteError, type ComprobanteCtx } from './flito-comprobantes.service.js';

const log = loggerFor('flito-comprobantes-auto');

/** La flag, leída en cada llamada (no al cargar el módulo): `'0'` apaga; ausente o `'1'` enciende (D5). */
export function autoAplicarEncendida(): boolean {
  return env.COMPROBANTES_AUTO_APLICAR !== '0';
}

/** Lo que la carga necesita para pintar el ítem aplicado: el DTO y las piezas del copy fijado. */
export interface AutoAplicado {
  detalle: ComprobanteDetalleDto;
  candidato: CandidatoTramiteDto;
  body: AplicarBody;
}

// ─────────────────────────── Condiciones ─────────────────────────────────────

/** Confiable con el umbral VIGENTE: hay valor, el OCR lo marcó y su confianza numérica lo alcanza (como `evaluar*`). */
const confiable = (c: CampoExtraido | undefined, umbral: number): c is CampoExtraido & { valor: string } =>
  !!c && !!c.valor && c.confiable === true && c.confianza >= umbral;

/**
 * El cuerpo con el que `aplicar` se invoca, o `null` con por qué no (para el log, sin contenido leído).
 * Reutiliza el cruce YA calculado por la carga (AC5: ni una lectura más por sub-documento).
 */
export function decidirAutoAplicar(lectura: LecturaSubDocumento | null, cruce: ResultadoCruce | null, umbral: number):
  { body: AplicarBody; candidato: CandidatoTramiteDto } | { razon: string } {
  if (!autoAplicarEncendida()) return { razon: 'flag_apagada' };
  if (!lectura || !cruce?.tramiteId || cruce.motivo !== null) return { razon: 'sin_cruce_unico' };
  const candidato = cruce.candidatos.find((c) => c.tramiteId === cruce.tramiteId);
  if (!candidato) return { razon: 'sin_cruce_unico' };

  const e = lectura.extraccion;
  const cols = columnasDeLectura(lectura, cruce);
  const tipo = e[CampoComprobante.TIPO_DOCUMENTO];
  const concepto = e[CampoComprobante.CONCEPTO];
  const esPago = e[CampoComprobante.ES_COMPROBANTE_PAGO];
  const valor = e[CampoComprobante.VALOR_TOTAL];
  if (!confiable(tipo, umbral) || !cols.tipoDocumento) return { razon: 'tipo_no_confiable' };
  if (!confiable(concepto, umbral) || !cols.concepto) return { razon: 'concepto_no_confiable' };
  if (!confiable(esPago, umbral) || cols.esPago !== true) return { razon: 'es_pago_no_confiable' };
  if (!confiable(valor, umbral) || !cols.valor) return { razon: 'valor_no_confiable' };
  const conceptoLeido = cols.concepto as ConceptoCosto;
  if (candidato.admite[conceptoLeido] !== 'admite') return { razon: 'destino_no_admite' };

  const veredicto = veredictoDelDueno(conceptoLeido, lectura, candidato, umbral);
  if (veredicto !== null) return { razon: veredicto };
  return { body: { tramiteId: cruce.tramiteId, concepto: conceptoLeido, esPago: true, campos: {} }, candidato };
}

/**
 * En SOAT / impuesto / derecho, el dueño decide sobre SU extracción (la especializada, `extraccionDestino`):
 * sin ella no hay veredicto (no corrió el extractor del tipo) y no se aplica. `null` = aprobado; si no,
 * la razón (el `motivo` del veredicto, sin su `detalle`: ese puede llevar lo leído).
 */
function veredictoDelDueno(concepto: ConceptoCosto, lectura: LecturaSubDocumento, candidato: CandidatoTramiteDto, umbral: number): string | null {
  if (concepto !== ConceptoCosto.SOAT && concepto !== ConceptoCosto.IMPUESTO && concepto !== ConceptoCosto.DERECHO) return null;
  const destino = lectura.extraccionDestino;
  if (!destino) return 'sin_extraccion_del_dueno';
  const v = concepto === ConceptoCosto.SOAT
    ? evaluarExtraccionSoat(destino as ExtraccionSoat, { vin: candidato.vin ?? '', placa: candidato.placa ?? null }, umbral)
    : concepto === ConceptoCosto.IMPUESTO
      ? evaluarReciboImpuesto(destino as ExtraccionImpuesto, umbral)
      : evaluarDerecho(destino as ExtraccionDerechoTramite, umbral);
  return v.aprobada ? null : `dueno_${v.motivo ?? 'rechaza'}`;
}

// ─────────────────────────── autoAplicar ─────────────────────────────────────

/**
 * Intenta aplicar solo el comprobante `id` (ya persistido `pendiente` con la sugerencia). Devuelve el
 * DTO aplicado, o `null` si alguna condición no se cumple (la fila no se toca). Lanza lo que lance
 * `aplicar` (ComprobanteError del esqueleto o del dueño): el llamador decide qué hacer con el envío.
 */
export async function autoAplicar(id: string, lectura: LecturaSubDocumento | null, cruce: ResultadoCruce | null, ctx: ComprobanteCtx): Promise<AutoAplicado | null> {
  const decision = decidirAutoAplicar(lectura, cruce, umbralPara(null));
  if ('razon' in decision) {
    log.debug({ comprobanteId: id, razon: decision.razon }, 'Comprobante no se auto-aplica');
    return null;
  }
  const detalle = await aplicar(id, decision.body, ctx, { automatico: true });
  return { detalle, candidato: decision.candidato, body: decision.body };
}

/** Para el llamador que captura (AC3): qué loguear de un fallo sin arrastrar contenido leído. */
export function resumenFallo(e: unknown): { codigo: string | null; status: number | null; nombre: string } {
  if (e instanceof ComprobanteError) return { codigo: e.codigo, status: e.status, nombre: e.name };
  return { codigo: null, status: null, nombre: e instanceof Error ? e.name : 'desconocido' };
}
