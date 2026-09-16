// Comprobantes universales (Épica #12245, Feature #12605, ADR-0018) — HU #12611: consultas, detalle,
// archivo y relectura. La carga en lotes vive en `flito-comprobantes.carga.ts` (mismo módulo, otro
// archivo por el techo de max-lines); las dos comparten de aquí `columnasDeLectura` y
// `motivoPendienteDe`, que son la única traducción «lectura → fila» del módulo.
//
// F2 (#12606, HU #12629): la traducción recibe además el resultado del CRUCE (`flito-comprobantes.cruce.ts`)
// y deja `tramite_id`/`cruce` SUGERIDOS en el pendiente; el detalle trae `candidatos[]`; y el listado
// filtra por estado de asociación. Aplicar y descartar viven en `flito-comprobantes.aplicar.ts`.
// `extraccion` y `extraccion_destino` NUNCA salen en el listado ni en los candidatos (ADR-0008 §1.2):
// el detalle las traduce a `campos[]` con el nivel calculado aquí (`nivelDe`), para que el front no
// derive nada. Y ningún log lleva contenido leído (Habeas Data).

import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  CAMPOS_COMPROBANTE, CampoComprobante, CodigoErrorComprobante, ConceptoCosto, EstadoComprobante,
  MotivoPendienteComprobante, TipoDocumentoComprobante, type AsociacionComprobante, type CampoComprobanteDto,
  type CampoExtraido, type ComprobanteDetalleDto, type ComprobanteListaDto, type ErrorComprobanteDto,
  type ExtraccionComprobante, type ListaComprobantesDto, type NivelConfianza,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoComprobantes, flitoSoportes, flitoTramites, users, vehicles } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { getEntityDocumentStream, presignedGetEntityDocument } from '../../services/storage.js';
import { recortarPaginas } from '../../shared/pdf/separar-paginas.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
import { umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { leerSubDocumento, type LecturaSubDocumento, type SubDocumentoApi } from './flito-comprobantes.ocr.js';
import { candidatosPorLlave, cruzarLectura, type ResultadoCruce } from './flito-comprobantes.cruce.js';

const log = loggerFor('flito-comprobantes');

/** Vida de la URL prefirmada del archivo (calco de flito-revisiones). */
export const ARCHIVO_URL_TTL_S = 300;

/** Los campos extra del cuerpo de error (`detalle`, `puedeAdjuntar`, `comprobanteAnteriorId`), según el código. */
export type ExtraError = Omit<ErrorComprobanteDto, 'error' | 'codigo'>;

export class ComprobanteError extends Error {
  constructor(public status: number, public codigo: CodigoErrorComprobante, message: string, public extra: ExtraError = {}) { super(message); }
  /** El cuerpo HTTP: `{ error, codigo }` y, si los hay, los extras del código. */
  cuerpo(): ErrorComprobanteDto { return { error: this.message, codigo: this.codigo, ...this.extra }; }
}

/** HU #12630: `role` porque los dueños (SoatCtx / ImpuestoCtx / DerechoCtx / RevisionCtx) lo exigen. */
export interface ComprobanteCtx { userId: number; username: string; role: string }

// ─────────────────────────── Nivel de confianza (R2) ─────────────────────────

/**
 * Nivel que la pantalla pinta para un campo. Los cortes son los de `CONFIANZA_NUMERICA` del OCR
 * (0.95 / 0.6 / 0.3) plegados a tres niveles: `alta` ⇔ `confiable` con el umbral vigente; `media`
 * desde 0.6; `baja` mientras haya algo; `null` cuando la confianza es 0 (el OCR no leyó el campo —
 * un «baja» ahí diría que leyó algo, y no leyó nada).
 */
export function nivelDe(confianza: number, umbral: number): NivelConfianza {
  if (confianza >= umbral) return 'alta';
  if (confianza >= 0.6) return 'media';
  if (confianza > 0) return 'baja';
  return null;
}

// ─────────────────────────── Lectura → fila ──────────────────────────────────

const campoDe = (e: ExtraccionComprobante, c: CampoComprobante): CampoExtraido | undefined => e[c];
const valorConfiable = (e: ExtraccionComprobante, c: CampoComprobante): string | null => {
  const campo = campoDe(e, c);
  return campo?.confiable && campo.valor ? campo.valor : null;
};
const valorLeido = (e: ExtraccionComprobante, c: CampoComprobante): string | null => campoDe(e, c)?.valor ?? null;
const cotar = (v: string | null, largo: number): string | null => (v ? v.slice(0, largo) : null);

const TIPOS: readonly string[] = Object.values(TipoDocumentoComprobante);
const CONCEPTOS: readonly string[] = Object.values(ConceptoCosto);

/**
 * Por qué queda pendiente, en ESTE orden de precedencia (HU #12611 AC5, extendida por la HU #12629
 * AC4): sin lectura → sin tipo → sin concepto → sin llave → la llave no cruza → cruce ambiguo → el
 * destino no admite → pago sin valor confiable → leído. Cada escalón supone el anterior resuelto: un
 * comprobante sin tipo tampoco tiene concepto, y decirle «concepto desconocido» sería señalar el
 * síntoma y no la causa.
 *
 * `null` de lectura = OCR caído. El tipo y el concepto cuentan solo si son CONFIABLES (son los que se
 * persisten en columna); las llaves cuentan con cualquier confianza (se persisten como leídas y la
 * persona las ve en el detalle con su nivel). `cruce` es el resultado de `cruzarLectura`; sin él
 * (F1, o un llamador que no cruza) los tres escalones del cruce no existen.
 */
export function motivoPendienteDe(lectura: ExtraccionComprobante | null, cruce: ResultadoCruce | null = null): MotivoPendienteComprobante {
  if (lectura === null) return MotivoPendienteComprobante.OCR_NO_DISPONIBLE;
  if (!valorConfiable(lectura, CampoComprobante.TIPO_DOCUMENTO)) return MotivoPendienteComprobante.TIPO_NO_IDENTIFICADO;
  if (!valorConfiable(lectura, CampoComprobante.CONCEPTO)) return MotivoPendienteComprobante.CONCEPTO_DESCONOCIDO;
  const hayLlave = [CampoComprobante.PLACA, CampoComprobante.VIN, CampoComprobante.ID_FLIT].some((c) => valorLeido(lectura, c));
  if (!hayLlave) return MotivoPendienteComprobante.SIN_LLAVE_DE_CRUCE;
  if (cruce?.motivo) return cruce.motivo;
  const esPago = valorConfiable(lectura, CampoComprobante.ES_COMPROBANTE_PAGO) === 'true';
  if (esPago && !valorConfiable(lectura, CampoComprobante.VALOR_TOTAL)) return MotivoPendienteComprobante.CONFIANZA_INSUFICIENTE;
  return MotivoPendienteComprobante.LEIDO;
}

/** Lo que `numeric(14,2)` acepta: el normalizador de pesos ya deja un entero, pero se comprueba igual. */
const esNumero = (v: string | null): v is string => v !== null && /^\d{1,12}(\.\d{1,2})?$/.test(v);
const esFechaIso = (v: string | null): v is string => v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Las columnas de `flito_comprobantes` que salen de una lectura (o de su ausencia). Las planas
 * (`placa_leida`, `valor`, …) llevan lo LEÍDO con cualquier confianza —la persona las verá con su
 * nivel—; `tipo_documento`, `es_pago` y `concepto` solo si el campo es confiable, porque son las que
 * F2 usa para decidir y una adivinanza ahí se convertiría en un cruce equivocado. Con OCR caído,
 * `extraccion = {}` (nunca NULL: la columna es NOT NULL y «vacío» es la verdad).
 *
 * Con `cruce` (HU #12629 AC4), `tramite_id` y `cruce` quedan SUGERIDOS solo cuando el cruce es único
 * o desempatado; en `cruce_ambiguo` los dos van NULL (no se adivina el primero de la lista).
 */
export function columnasDeLectura(lectura: LecturaSubDocumento | null, cruce: ResultadoCruce | null = null) {
  const e = lectura?.extraccion ?? null;
  const motivoPendiente = motivoPendienteDe(e, cruce);
  if (!e) {
    return {
      extraccion: {} as ExtraccionComprobante, extraccionDestino: null, motivoPendiente,
      tipoDocumento: null, esPago: null, concepto: null, tramiteId: null, cruce: null,
      placaLeida: null, vinLeido: null, idFlitLeido: null, valor: null, fechaDocumento: null, numeroDocumento: null, emisor: null,
    };
  }
  const tipo = valorConfiable(e, CampoComprobante.TIPO_DOCUMENTO);
  const concepto = valorConfiable(e, CampoComprobante.CONCEPTO);
  const esPago = valorConfiable(e, CampoComprobante.ES_COMPROBANTE_PAGO);
  const valor = valorLeido(e, CampoComprobante.VALOR_TOTAL);
  const fecha = valorLeido(e, CampoComprobante.FECHA_PAGO);
  return {
    extraccion: e,
    extraccionDestino: lectura?.extraccionDestino ?? null,
    motivoPendiente,
    tipoDocumento: tipo && TIPOS.includes(tipo) ? tipo : null,
    esPago: esPago === 'true' ? true : esPago === 'false' ? false : null,
    concepto: concepto && CONCEPTOS.includes(concepto) ? concepto : null,
    tramiteId: cruce?.tramiteId ?? null,
    cruce: cruce?.tramiteId ? cruce.cruce : null,
    placaLeida: cotar(valorLeido(e, CampoComprobante.PLACA), 10),
    vinLeido: cotar(valorLeido(e, CampoComprobante.VIN), 30),
    idFlitLeido: cotar(valorLeido(e, CampoComprobante.ID_FLIT), 60),
    valor: esNumero(valor) ? valor : null,
    fechaDocumento: esFechaIso(fecha) ? fecha : null,
    numeroDocumento: cotar(valorLeido(e, CampoComprobante.NUMERO_DOCUMENTO), 60),
    emisor: cotar(valorLeido(e, CampoComprobante.EMISOR), 150),
  };
}

// ─────────────────────────── Listado ─────────────────────────────────────────

export interface FiltrosListado {
  estado?: EstadoComprobante;
  concepto?: ConceptoCosto;
  motivo?: MotivoPendienteComprobante;
  loteId?: string;
  tramiteId?: string;
  /** HU #12629 AC8: estado de asociación, un vocabulario de pantalla que se traduce a columnas. */
  asociacion?: AsociacionComprobante;
  page: number;
  pageSize: number;
}

/**
 * La traducción del filtro `asociacion` (AC8). Cada literal se liga UNA vez como parámetro: Drizzle no
 * deduplica literales (Bug #12058), así que `estado = 'aplicado'` no se repite dentro de una misma rama.
 */
export function condicionAsociacion(a: AsociacionComprobante): SQL {
  switch (a) {
    case 'pendiente': return eq(flitoComprobantes.estado, EstadoComprobante.PENDIENTE);
    case 'aplicado_automatico':
      return and(eq(flitoComprobantes.estado, EstadoComprobante.APLICADO), eq(flitoComprobantes.esPago, true), eq(flitoComprobantes.aplicadoAutomaticamente, true))!;
    case 'aplicado_manual':
      return and(eq(flitoComprobantes.estado, EstadoComprobante.APLICADO), eq(flitoComprobantes.esPago, true), eq(flitoComprobantes.aplicadoAutomaticamente, false))!;
    case 'adjuntado': return and(eq(flitoComprobantes.estado, EstadoComprobante.APLICADO), eq(flitoComprobantes.esPago, false))!;
    case 'rechazado_pago':
      return and(eq(flitoComprobantes.estado, EstadoComprobante.PENDIENTE), eq(flitoComprobantes.motivoPendiente, MotivoPendienteComprobante.DESTINO_NO_ADMITE))!;
    case 'descartado': return eq(flitoComprobantes.estado, EstadoComprobante.DESCARTADO);
    default: { const nunca: never = a; throw new Error(`Asociación desconocida: ${String(nunca)}`); }
  }
}

const aplicadoPor = alias(users, 'aplicado_por');
const descartadoPor = alias(users, 'descartado_por');

/**
 * El WHERE del listado, exportado para que el test lo renderice (el mock ignora `where`). Los
 * literales de `estado` y `concepto` vienen de un enum de Zod (catálogo cerrado) y van UNA vez cada
 * uno como parámetro: nada aquí repite un literal (Bug #12058).
 */
export function condicionesListado(f: FiltrosListado): SQL | undefined {
  const c: SQL[] = [];
  if (f.estado) c.push(eq(flitoComprobantes.estado, f.estado));
  if (f.concepto) c.push(eq(flitoComprobantes.concepto, f.concepto));
  if (f.motivo) c.push(eq(flitoComprobantes.motivoPendiente, f.motivo));
  if (f.loteId) c.push(eq(flitoComprobantes.loteId, f.loteId));
  if (f.tramiteId) c.push(eq(flitoComprobantes.tramiteId, f.tramiteId));
  if (f.asociacion) c.push(condicionAsociacion(f.asociacion));
  return c.length ? and(...c) : undefined;
}

/** created_at DESC, luego nombre de archivo, luego la primera página (los de un consolidado, en orden). */
export function ordenListado(): SQL[] {
  return [
    desc(flitoComprobantes.createdAt),
    asc(flitoSoportes.nombreArchivo),
    sql`(${flitoComprobantes.paginas}->>0)::int ASC NULLS FIRST`,
  ];
}

/** La proyección del listado: SIN `extraccion` ni `extraccion_destino` (mutante (7) del diseño). */
export const PROYECCION_LISTA = {
  id: flitoComprobantes.id,
  loteId: flitoComprobantes.loteId,
  estado: flitoComprobantes.estado,
  motivoPendiente: flitoComprobantes.motivoPendiente,
  detallePendiente: flitoComprobantes.detallePendiente,
  tipoDocumento: flitoComprobantes.tipoDocumento,
  esPago: flitoComprobantes.esPago,
  concepto: flitoComprobantes.concepto,
  tramiteId: flitoComprobantes.tramiteId,
  tramiteIdFlit: flitoTramites.idFlit,
  tramitePlaca: vehicles.plate,
  cruce: flitoComprobantes.cruce,
  placaLeida: flitoComprobantes.placaLeida,
  vinLeido: flitoComprobantes.vinLeido,
  idFlitLeido: flitoComprobantes.idFlitLeido,
  valor: flitoComprobantes.valor,
  fechaDocumento: flitoComprobantes.fechaDocumento,
  numeroDocumento: flitoComprobantes.numeroDocumento,
  emisor: flitoComprobantes.emisor,
  marcadoPorDiferencia: flitoComprobantes.marcadoPorDiferencia,
  diferenciaTarifa: flitoComprobantes.diferenciaTarifa,
  diferenciaAceptadaEn: flitoComprobantes.diferenciaAceptadaEn,
  paginas: flitoComprobantes.paginas,
  archivoNombre: flitoSoportes.nombreArchivo,
  archivoContentType: flitoSoportes.contentType,
  createdAt: flitoComprobantes.createdAt,
  aplicadoEn: flitoComprobantes.aplicadoEn,
  aplicadoAutomaticamente: flitoComprobantes.aplicadoAutomaticamente,
  descartadoEn: flitoComprobantes.descartadoEn,
  subidoPorNombre: flitoComprobantes.subidoPorNombre,
  aplicadoPorNombre: aplicadoPor.username,
  descartadoPorNombre: descartadoPor.username,
} as const;

type FilaLista = { [K in keyof typeof PROYECCION_LISTA]: (typeof PROYECCION_LISTA)[K]['_']['data'] | null };

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

function aListaDto(r: FilaLista): ComprobanteListaDto {
  return {
    id: r.id!,
    loteId: r.loteId!,
    estado: r.estado as EstadoComprobante,
    motivoPendiente: (r.motivoPendiente as MotivoPendienteComprobante | null) ?? null,
    detallePendiente: r.detallePendiente ?? null,
    tipoDocumento: (r.tipoDocumento as TipoDocumentoComprobante | null) ?? null,
    esPago: r.esPago ?? null,
    concepto: (r.concepto as ConceptoCosto | null) ?? null,
    tramite: r.tramiteId && r.tramiteIdFlit ? { id: r.tramiteId, idFlit: r.tramiteIdFlit, placa: r.tramitePlaca ?? null } : null,
    cruce: (r.cruce as ComprobanteListaDto['cruce']) ?? null,
    placaLeida: r.placaLeida ?? null,
    vinLeido: r.vinLeido ?? null,
    idFlitLeido: r.idFlitLeido ?? null,
    valor: num(r.valor),
    fechaDocumento: r.fechaDocumento ?? null,
    numeroDocumento: r.numeroDocumento ?? null,
    emisor: r.emisor ?? null,
    marcadoPorDiferencia: r.marcadoPorDiferencia ?? false,
    diferenciaTarifa: num(r.diferenciaTarifa),
    diferenciaAceptada: r.diferenciaAceptadaEn !== null && r.diferenciaAceptadaEn !== undefined,
    paginas: r.paginas ?? null,
    archivo: { nombre: r.archivoNombre ?? '', contentType: r.archivoContentType ?? '' },
    createdAt: iso(r.createdAt)!,
    aplicadoEn: iso(r.aplicadoEn),
    aplicadoAutomaticamente: r.aplicadoAutomaticamente ?? false,
    descartadoEn: iso(r.descartadoEn),
    subidoPorNombre: r.subidoPorNombre ?? '',
    aplicadoPorNombre: r.aplicadoPorNombre ?? null,
    descartadoPorNombre: r.descartadoPorNombre ?? null,
  };
}

function consultaLista() {
  return db.select(PROYECCION_LISTA).from(flitoComprobantes)
    .innerJoin(flitoSoportes, eq(flitoSoportes.id, flitoComprobantes.soporteId))
    .leftJoin(flitoTramites, eq(flitoTramites.id, flitoComprobantes.tramiteId))
    .leftJoin(vehicles, eq(vehicles.id, flitoTramites.vehiculoId))
    .leftJoin(aplicadoPor, eq(aplicadoPor.id, flitoComprobantes.aplicadoPorId))
    .leftJoin(descartadoPor, eq(descartadoPor.id, flitoComprobantes.descartadoPorId));
}

export async function listar(f: FiltrosListado): Promise<ListaComprobantesDto> {
  const where = condicionesListado(f);
  const [conteo] = await db.select({ total: sql<number>`count(*)::int` }).from(flitoComprobantes).where(where);
  const filas = await consultaLista().where(where).orderBy(...ordenListado())
    .limit(f.pageSize).offset((f.page - 1) * f.pageSize);
  return { items: (filas as FilaLista[]).map(aListaDto), total: conteo?.total ?? 0, page: f.page, pageSize: f.pageSize };
}

// ─────────────────────────── Detalle ─────────────────────────────────────────

const campoVacio: CampoExtraido = { valor: null, confianza: 0, confiable: false };

/**
 * `campos[]` del detalle: los diez universales SIEMPRE (aunque el OCR no los haya leído: ahí van con
 * confianza 0 y nivel `null`) y, si hubo extracción especializada, los suyos con el prefijo
 * `destino.` para que `valorTotal` del SOAT no pise a `valorTotal` universal.
 */
export function camposDe(extraccion: ExtraccionComprobante, extraccionDestino: Record<string, CampoExtraido> | null, umbral: number): CampoComprobanteDto[] {
  const aDto = (campo: string, c: CampoExtraido): CampoComprobanteDto => ({
    campo, valor: c.valor ?? null, confianza: c.confianza ?? 0, confiable: c.confiable ?? false,
    nivel: nivelDe(c.confianza ?? 0, umbral), confirmadoPor: c.confirmadoPor ?? null,
  });
  const universales = CAMPOS_COMPROBANTE.map((c) => aDto(c, extraccion[c] ?? campoVacio));
  const destino = extraccionDestino ? Object.entries(extraccionDestino).map(([k, c]) => aDto(`destino.${k}`, c ?? campoVacio)) : [];
  return [...universales, ...destino];
}

export async function detalle(id: string): Promise<ComprobanteDetalleDto> {
  const [fila] = await consultaLista().where(eq(flitoComprobantes.id, id)).limit(1);
  if (!fila) throw new ComprobanteError(404, CodigoErrorComprobante.NO_ENCONTRADO, 'El comprobante no existe');
  // Lo que SOLO el detalle expone: la lectura cruda y, para la ficha (HU #12634 AC6), los motivos y el
  // soporte hijo aplicado. Fuera de `PROYECCION_LISTA` a propósito: la cola no los trae.
  const [lectura] = await db.select({
    extraccion: flitoComprobantes.extraccion, extraccionDestino: flitoComprobantes.extraccionDestino,
    aplicadoMotivo: flitoComprobantes.aplicadoMotivo, descartadoMotivo: flitoComprobantes.descartadoMotivo,
    soporteAplicadoId: flitoComprobantes.soporteAplicadoId,
  }).from(flitoComprobantes).where(eq(flitoComprobantes.id, id)).limit(1);
  const base = aListaDto(fila as FilaLista);
  // Candidatos solo en pendientes (AC5): en aplicados y descartados ya no hay nada que elegir.
  const candidatos = base.estado === EstadoComprobante.PENDIENTE
    ? (await candidatosPorLlave({ idFlit: base.idFlitLeido, vin: base.vinLeido, placa: base.placaLeida })).candidatos
    : [];
  return {
    ...base,
    campos: camposDe(lectura?.extraccion ?? {}, (lectura?.extraccionDestino as Record<string, CampoExtraido> | null) ?? null, umbralPara(null)),
    candidatos,
    aplicadoMotivo: lectura?.aplicadoMotivo ?? null,
    descartadoMotivo: lectura?.descartadoMotivo ?? null,
    soporteAplicadoId: lectura?.soporteAplicadoId ?? null,
  };
}

// ─────────────────────────── Archivo ─────────────────────────────────────────

/**
 * URL prefirmada (300 s) del archivo del comprobante: el original (`soporte_id`) o, con `aplicado`,
 * el hijo recortado que vio el destino (`soporte_aplicado_id`, F2) — 404 si no lo hay.
 */
export async function urlArchivo(id: string, aplicado: boolean): Promise<string> {
  const [c] = await db.select({ soporteId: flitoComprobantes.soporteId, soporteAplicadoId: flitoComprobantes.soporteAplicadoId })
    .from(flitoComprobantes).where(eq(flitoComprobantes.id, id)).limit(1);
  if (!c) throw new ComprobanteError(404, CodigoErrorComprobante.NO_ENCONTRADO, 'El comprobante no existe');
  const soporteId = aplicado ? c.soporteAplicadoId : c.soporteId;
  if (!soporteId) throw new ComprobanteError(404, CodigoErrorComprobante.NO_ENCONTRADO, 'El comprobante no tiene archivo aplicado');
  const [s] = await db.select({ storageKey: flitoSoportes.storageKey }).from(flitoSoportes).where(eq(flitoSoportes.id, soporteId)).limit(1);
  if (!s) throw new ComprobanteError(404, CodigoErrorComprobante.NO_ENCONTRADO, 'El archivo del comprobante no existe');
  return presignedGetEntityDocument(s.storageKey, ARCHIVO_URL_TTL_S);
}

// ─────────────────────────── Releer ──────────────────────────────────────────

async function aBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const trozos: Buffer[] = [];
  for await (const t of stream) trozos.push(Buffer.from(t));
  return Buffer.concat(trozos);
}

/**
 * Vuelve a pasar por el OCR un comprobante que quedó sin lectura (`ocr_no_disponible`): descarga el
 * soporte, reconstruye el sub-documento con sus `paginas` (o el archivo entero) y repite
 * `leerSubDocumento`. Reescribe la fila con `columnasDeLectura` (con el cruce de la nueva lectura,
 * HU #12629) — NUNCA inserta: el comprobante ya existe y el archivo también. Si el OCR sigue caído,
 * 503 y la fila no cambia (ni `updated_at`).
 */
export async function releer(id: string, ctx: ComprobanteCtx): Promise<ComprobanteDetalleDto> {
  const [c] = await db.select({
    id: flitoComprobantes.id, estado: flitoComprobantes.estado, motivoPendiente: flitoComprobantes.motivoPendiente,
    soporteId: flitoComprobantes.soporteId, paginas: flitoComprobantes.paginas,
  }).from(flitoComprobantes).where(eq(flitoComprobantes.id, id)).limit(1);
  if (!c) throw new ComprobanteError(404, CodigoErrorComprobante.NO_ENCONTRADO, 'El comprobante no existe');
  if (c.estado !== EstadoComprobante.PENDIENTE) throw new ComprobanteError(409, CodigoErrorComprobante.YA_RESUELTO, 'El comprobante ya no está pendiente');
  if (c.motivoPendiente !== MotivoPendienteComprobante.OCR_NO_DISPONIBLE) {
    throw new ComprobanteError(409, CodigoErrorComprobante.SIN_RELECTURA, 'Solo se relee un comprobante que quedó sin lectura');
  }
  const [s] = await db.select({ storageKey: flitoSoportes.storageKey, nombreArchivo: flitoSoportes.nombreArchivo, contentType: flitoSoportes.contentType })
    .from(flitoSoportes).where(eq(flitoSoportes.id, c.soporteId)).limit(1);
  if (!s) throw new ComprobanteError(404, CodigoErrorComprobante.NO_ENCONTRADO, 'El archivo del comprobante no existe');

  const entero = await aBuffer(await getEntityDocumentStream(s.storageKey) as AsyncIterable<Uint8Array>);
  const paginas = c.paginas ?? null;
  const sub: SubDocumentoApi = {
    buffer: paginas ? await recortarPaginas(entero, paginas) : entero,
    contentType: s.contentType, paginas, nombre: s.nombreArchivo,
  };

  let lectura: LecturaSubDocumento;
  try {
    lectura = await leerSubDocumento(sub);
  } catch (e) {
    if (e instanceof OcrNoDisponibleError) {
      log.warn({ comprobanteId: id, paginas: paginas?.length ?? null }, 'Relectura: OCR sigue no disponible');
      throw new ComprobanteError(503, CodigoErrorComprobante.OCR_NO_DISPONIBLE, 'El OCR sigue sin estar disponible; inténtalo más tarde');
    }
    throw e;
  }

  const cruce = await cruzarLectura(lectura.extraccion);
  const columnas = columnasDeLectura(lectura, cruce);
  await db.update(flitoComprobantes)
    .set({ ...columnas, detallePendiente: null, updatedAt: new Date() })
    .where(eq(flitoComprobantes.id, id));
  log.info({ comprobanteId: id, por: ctx.userId, motivo: columnas.motivoPendiente, cruce: columnas.cruce }, 'Comprobante releído');
  return detalle(id);
}
