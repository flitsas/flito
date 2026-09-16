// Comprobantes universales (Épica #12245, Feature #12606, ADR-0018 §4) — HU #12629: el CRUCE.
//
// Un comprobante leído trae hasta tres llaves (ID FLIT, VIN, placa) y ninguna es infalible: el OCR
// puede leer «FLIT-ARHZZ1» donde decía «FLIT-ARH221» y a la vez leer la placa nítida. Por eso el
// cruce prueba las llaves por PRIORIDAD (id_flit > vin > placa: de la más específica a la más
// compartida) y la primera que alcanza ≥ 1 trámite fija cómo se llegó (`cruce`); una llave que da 0
// no bloquea a la siguiente (D4).
//
// D8: NO se filtra por autogestión ni por gestor. El financiero ve todos los trámites que la llave
// alcanza y decide; lo que cada uno admite por concepto (`admite`) es información, no una valla.
// D11: un comprobante = un trámite. Con varios candidatos solo se fija el cruce cuando EXACTAMENTE uno
// admite el concepto leído; si no, `cruce_ambiguo` y `tramite_id` NULL (no se adivina).
//
// Habeas Data: el candidato NO lleva datos de persona (ni propietario, ni cédula, ni teléfono): llaves
// del vehículo, tipo, empresa y estados. Ningún log de aquí lleva una llave leída.

import { desc, eq, or, sql, type SQL } from 'drizzle-orm';
import {
  CampoComprobante, CONCEPTOS_COSTO, ConceptoCosto, CruceComprobante, MotivoPendienteComprobante,
  type AdmisionConcepto, type CandidatoTramiteDto, type ExtraccionComprobante,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoComprobantes, flitoDerechosTramite, flitoImpuestos, flitoLiquidaciones, flitoSoat, flitoTramites, vehicles,
} from '../../db/schema.js';

/** Tope del buscador manual (`POST /tramites/buscar`): más de 20 no es «buscar», es listar. */
export const MAX_CANDIDATOS_BUSQUEDA = 20;

export interface LlavesLeidas { idFlit: string | null; vin: string | null; placa: string | null }

/** Por qué llave se cruzó (nunca `manual`: eso lo pone una persona al aplicar). */
export type CrucePorLlave = typeof CruceComprobante.ID_FLIT | typeof CruceComprobante.VIN | typeof CruceComprobante.PLACA;

/** Lo que devuelve `candidatosPorLlave`: los candidatos y con qué llave se alcanzaron. */
export interface HallazgoPorLlave {
  candidatos: CandidatoTramiteDto[];
  /** La llave que produjo los candidatos; `null` si ninguna alcanzó nada. */
  cruce: CrucePorLlave | null;
  /** false cuando la lectura no trajo ninguna llave (entonces el motivo es `sin_llave_de_cruce`, no `llave_no_cruza`). */
  hayLlave: boolean;
}

export type MotivoCruce =
  | typeof MotivoPendienteComprobante.SIN_LLAVE_DE_CRUCE
  | typeof MotivoPendienteComprobante.LLAVE_NO_CRUZA
  | typeof MotivoPendienteComprobante.CRUCE_AMBIGUO
  | typeof MotivoPendienteComprobante.DESTINO_NO_ADMITE;

export interface ResultadoCruce {
  /** Fijado solo con cruce único o desempatado; NULL en ambiguo o sin candidatos. */
  tramiteId: string | null;
  cruce: CrucePorLlave | null;
  /** `null` cuando el cruce quedó fijado y el destino admite: el motivo lo decide el resto de la lectura. */
  motivo: MotivoCruce | null;
  candidatos: CandidatoTramiteDto[];
}

// ─────────────────────────── Normalización de llaves ─────────────────────────

/** Igualdad NORMALIZADA (nunca LIKE): mayúsculas y, en la placa, sin guiones — lo mismo que hace el SQL del otro lado. */
const normalizar = (v: string): string => v.trim().toUpperCase();
const normalizarPlaca = (v: string): string => normalizar(v).replace(/-/g, '');

/**
 * El predicado de cada llave, exportado para que el test lo renderice: `UPPER(id_flit) = $`,
 * `UPPER(vin) = $`, `UPPER(REPLACE(plate, '-', '')) = $`. Igualdad y no `LIKE` (AC2): «ABC12» no
 * debe alcanzar a «ABC123».
 */
export function condicionLlave(tipo: CrucePorLlave, valor: string): SQL {
  if (tipo === CruceComprobante.ID_FLIT) return sql`UPPER(${flitoTramites.idFlit}) = ${normalizar(valor)}`;
  if (tipo === CruceComprobante.VIN) return sql`UPPER(${vehicles.vin}) = ${normalizar(valor)}`;
  return sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) = ${normalizarPlaca(valor)}`;
}

/** El predicado del buscador manual: contención en cualquiera de las tres llaves (aquí sí LIKE: es una caja de búsqueda). */
export function condicionBusqueda(buscar: string): SQL {
  const texto = normalizar(buscar);
  return or(
    sql`UPPER(${flitoTramites.idFlit}) LIKE ${`%${texto}%`}`,
    sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${`%${normalizarPlaca(buscar)}%`}`,
    sql`UPPER(${vehicles.vin}) LIKE ${`%${texto}%`}`,
  )!;
}

// ─────────────────────────── La consulta ─────────────────────────────────────

/** `EXISTS` de un comprobante APLICADO como pago de ese concepto sobre el trámite (→ `ya_documentado`). */
const documentado = (concepto: ConceptoCosto): SQL<boolean> => sql<boolean>`EXISTS (
  SELECT 1 FROM ${flitoComprobantes}
  WHERE ${flitoComprobantes.tramiteId} = ${flitoTramites.id}
    AND ${flitoComprobantes.estado} = 'aplicado' AND ${flitoComprobantes.esPago} = true
    AND ${flitoComprobantes.concepto} = ${concepto})`;

/**
 * Lo que hace falta para decidir `admite` por concepto, en UNA fila por trámite. Sin `document` del
 * cliente ni columnas de persona; sin `logistica_autogestionable` ni gestor (D8: el SQL no los mira).
 */
export const PROYECCION_CANDIDATO = {
  tramiteId: flitoTramites.id,
  idFlit: flitoTramites.idFlit,
  placa: vehicles.plate,
  vin: vehicles.vin,
  tipoTramite: flitoTramites.tipoTramite,
  empresa: clients.name,
  flitEstado: flitoTramites.flitEstado,
  soatId: flitoTramites.soatId,
  soatEstado: flitoSoat.estado,
  impuestoEstado: flitoImpuestos.estado,
  derechoId: flitoDerechosTramite.id,
  liquidacionId: flitoLiquidaciones.id,
  docTramiteDigital: documentado(ConceptoCosto.TRAMITE_DIGITAL),
  docLogistica: documentado(ConceptoCosto.LOGISTICA),
  docServiciosAdicionales: documentado(ConceptoCosto.SERVICIOS_ADICIONALES),
  createdAt: flitoTramites.createdAt,
} as const;

/** La fila que devuelve la consulta (los LEFT JOIN dejan `null` donde no hay registro). */
export interface FilaCandidato {
  tramiteId: string;
  idFlit: string;
  placa: string | null;
  vin: string | null;
  tipoTramite: string | null;
  empresa: string | null;
  flitEstado: string | null;
  soatId: string | null;
  soatEstado: string | null;
  impuestoEstado: string | null;
  derechoId: string | null;
  liquidacionId: string | null;
  docTramiteDigital: boolean | null;
  docLogistica: boolean | null;
  docServiciosAdicionales: boolean | null;
  createdAt: Date | string | null;
}

/** `flito_tramites ⋈ vehicles ⟕ clients ⟕ flito_soat (por soat_id) ⟕ flito_impuestos ⟕ flito_derechos_tramite ⟕ flito_liquidaciones`. */
function consultaCandidatos() {
  return db.select(PROYECCION_CANDIDATO).from(flitoTramites)
    .innerJoin(vehicles, eq(vehicles.id, flitoTramites.vehiculoId))
    .leftJoin(clients, eq(clients.id, flitoTramites.companiaId))
    .leftJoin(flitoSoat, eq(flitoSoat.id, flitoTramites.soatId))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .leftJoin(flitoLiquidaciones, eq(flitoLiquidaciones.tramiteId, flitoTramites.id));
}

// ─────────────────────────── admite por concepto ─────────────────────────────

/** SOAT e impuesto comparten regla: `solicitado` admite, `pagado` ya está, sin registro no se gestiona aquí, otro estado no permite. */
function admiteSolicitado(estado: string | null | undefined, existe: boolean): AdmisionConcepto {
  if (!existe) return 'no_gestionado';
  if (estado === 'solicitado') return 'admite';
  if (estado === 'pagado') return 'ya_pagado';
  return 'estado_no_permitido';
}

/** Honorarios: sellado → `liquidado`; ya hay un pago aplicado del concepto → `ya_documentado`; si no, admite. */
function admiteHonorario(liquidado: boolean, documentado: boolean): AdmisionConcepto {
  if (liquidado) return 'liquidado';
  if (documentado) return 'ya_documentado';
  return 'admite';
}

/**
 * `admite[concepto]` de un candidato (AC3). Derecho: trámite `aprobado` sin derecho registrado admite;
 * con derecho ya está pagado; no aprobado no permite. La logística autogestionada NO se calcula aquí:
 * sería informativa (no bloquea aplicar, cierre (e)) y exigiría mirar `logistica_autogestionable`, que
 * AC2 deja fuera del SQL (D8).
 */
export function admiteDe(f: FilaCandidato): Record<ConceptoCosto, AdmisionConcepto> {
  const liquidado = f.liquidacionId !== null && f.liquidacionId !== undefined;
  const aprobado = (f.flitEstado ?? '').toLowerCase() === 'aprobado';
  const hayDerecho = f.derechoId !== null && f.derechoId !== undefined;
  return {
    soat: admiteSolicitado(f.soatEstado, f.soatId !== null && f.soatId !== undefined),
    impuesto: admiteSolicitado(f.impuestoEstado, f.impuestoEstado !== null && f.impuestoEstado !== undefined),
    derecho: hayDerecho ? 'ya_pagado' : aprobado ? 'admite' : 'estado_no_permitido',
    tramite_digital: admiteHonorario(liquidado, f.docTramiteDigital === true),
    logistica: admiteHonorario(liquidado, f.docLogistica === true),
    servicios_adicionales: admiteHonorario(liquidado, f.docServiciosAdicionales === true),
  };
}

/** La fila → `CandidatoTramiteDto`: solo llaves del vehículo, tipo, empresa y estados (sin persona). */
export function aCandidato(f: FilaCandidato): CandidatoTramiteDto {
  return {
    tramiteId: f.tramiteId,
    idFlit: f.idFlit,
    placa: f.placa ?? null,
    vin: f.vin ?? null,
    tipoTramite: f.tipoTramite ?? null,
    empresa: f.empresa ?? null,
    flitEstado: f.flitEstado ?? null,
    liquidado: f.liquidacionId !== null && f.liquidacionId !== undefined,
    admite: admiteDe(f),
  };
}

// ─────────────────────────── Candidatos ──────────────────────────────────────

/** El orden de prueba: de la llave más específica a la más compartida. */
const PRIORIDAD: readonly CrucePorLlave[] = [CruceComprobante.ID_FLIT, CruceComprobante.VIN, CruceComprobante.PLACA];

const valorDe = (llaves: LlavesLeidas, tipo: CrucePorLlave): string | null =>
  tipo === CruceComprobante.ID_FLIT ? llaves.idFlit : tipo === CruceComprobante.VIN ? llaves.vin : llaves.placa;

/**
 * Los trámites que alcanza la primera llave CON VALOR que produce ≥ 1 candidato, en el orden
 * id_flit > vin > placa (AC2). Una llave de mayor prioridad que da 0 no bloquea a la siguiente: el
 * ID FLIT mal leído no debe tapar una placa nítida.
 */
export async function candidatosPorLlave(llaves: LlavesLeidas): Promise<HallazgoPorLlave> {
  let hayLlave = false;
  for (const tipo of PRIORIDAD) {
    const valor = valorDe(llaves, tipo);
    if (!valor || !valor.trim()) continue;
    hayLlave = true;
    const filas = await consultaCandidatos().where(condicionLlave(tipo, valor)).orderBy(desc(flitoTramites.createdAt));
    if (filas.length > 0) return { candidatos: (filas as FilaCandidato[]).map(aCandidato), cruce: tipo, hayLlave };
  }
  return { candidatos: [], cruce: null, hayLlave };
}

/** El buscador manual (`POST /tramites/buscar`): la misma forma y el mismo `admite`, tope 20, más recientes primero. */
export async function candidatosPorTexto(buscar: string): Promise<CandidatoTramiteDto[]> {
  const filas = await consultaCandidatos().where(condicionBusqueda(buscar))
    .orderBy(desc(flitoTramites.createdAt)).limit(MAX_CANDIDATOS_BUSQUEDA);
  return (filas as FilaCandidato[]).slice(0, MAX_CANDIDATOS_BUSQUEDA).map(aCandidato);
}

// ─────────────────────────── cruzar ──────────────────────────────────────────

const esConcepto = (v: string | null): v is ConceptoCosto => v !== null && (CONCEPTOS_COSTO as readonly string[]).includes(v);

/**
 * Decide el cruce (AC3): 0 candidatos → `llave_no_cruza` (o `sin_llave_de_cruce` si no había llave);
 * 1 → fijado aunque no admita el concepto (entonces `destino_no_admite`, con el candidato visible: D6);
 * > 1 → fijado solo si el concepto es conocido y EXACTAMENTE uno lo admite (desempate); si dos admiten
 * o ninguno, `cruce_ambiguo` con la lista y `tramite_id` NULL. Con concepto desconocido no hay desempate.
 */
export function cruzar(hallazgo: HallazgoPorLlave, concepto: ConceptoCosto | null): ResultadoCruce {
  const { candidatos, cruce, hayLlave } = hallazgo;
  if (candidatos.length === 0 || cruce === null) {
    return { tramiteId: null, cruce: null, candidatos, motivo: hayLlave ? MotivoPendienteComprobante.LLAVE_NO_CRUZA : MotivoPendienteComprobante.SIN_LLAVE_DE_CRUCE };
  }
  const admiteConcepto = (c: CandidatoTramiteDto): boolean => esConcepto(concepto) && c.admite[concepto] === 'admite';
  if (candidatos.length === 1) {
    const unico = candidatos[0]!;
    return { tramiteId: unico.tramiteId, cruce, candidatos, motivo: admiteConcepto(unico) ? null : MotivoPendienteComprobante.DESTINO_NO_ADMITE };
  }
  const admiten = candidatos.filter(admiteConcepto);
  if (admiten.length === 1) return { tramiteId: admiten[0]!.tramiteId, cruce, candidatos, motivo: null };
  return { tramiteId: null, cruce: null, candidatos, motivo: MotivoPendienteComprobante.CRUCE_AMBIGUO };
}

// ─────────────────────────── Desde una lectura ───────────────────────────────

const leido = (e: ExtraccionComprobante, c: CampoComprobante): string | null => e[c]?.valor ?? null;

/** Las tres llaves tal como el OCR las leyó (con cualquier confianza: la persona las ve con su nivel). */
export function llavesDe(e: ExtraccionComprobante): LlavesLeidas {
  return { idFlit: leido(e, CampoComprobante.ID_FLIT), vin: leido(e, CampoComprobante.VIN), placa: leido(e, CampoComprobante.PLACA) };
}

/** El concepto que desempata: solo si el OCR lo dio CONFIABLE (es el que se persiste en columna). */
export function conceptoConfiableDe(e: ExtraccionComprobante): ConceptoCosto | null {
  const campo = e[CampoComprobante.CONCEPTO];
  const v = campo?.confiable && campo.valor ? campo.valor : null;
  return esConcepto(v) ? v : null;
}

/**
 * El cruce de una lectura completa (la carga y la relectura lo invocan tras el OCR). `null` cuando no
 * hubo lectura: sin llaves no hay nada que cruzar y el motivo será `ocr_no_disponible`.
 */
export async function cruzarLectura(extraccion: ExtraccionComprobante | null): Promise<ResultadoCruce | null> {
  if (!extraccion) return null;
  const llaves = llavesDe(extraccion);
  if (!llaves.idFlit && !llaves.vin && !llaves.placa) {
    return { tramiteId: null, cruce: null, candidatos: [], motivo: MotivoPendienteComprobante.SIN_LLAVE_DE_CRUCE };
  }
  return cruzar(await candidatosPorLlave(llaves), conceptoConfiableDe(extraccion));
}
