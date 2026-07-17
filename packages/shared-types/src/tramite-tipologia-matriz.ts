// EPIC TRAM-INNOV · TRAM-TIPO-01 (Fase 3) — Matriz paso × tipología + journeys.
//
// PR-1 (ADITIVO, sin cambio de comportamiento): define, como FUENTE ÚNICA, QUIÉN
// participa en cada tipología (partes) y CÓMO cambia cada PASO del wizard según
// el tipo de trámite. PR-2 consume `vendedorRequerido()` / `getAdquirente()` para
// diferenciar el journey en el wizard (p.ej. traspaso exige vendedor; sucesión no).
//
// Relación con el catálogo de checklist (`tramite-tipologias.ts`): complementario,
// no lo reemplaza.
//   - tramite-tipologias.ts        → QUÉ anexos/documentos (checklist + gate).
//   - tramite-tipologia-matriz.ts  → QUIÉN (partes) y CÓMO (paso × tipología).
//
// PURA (sin IO). Los códigos referencian `TRAMITE_TIPOLOGIAS`; `matrizDriftIssues()`
// detecta desincronización entre ambos (usado por los tests, sin side-effects al
// importar el módulo).

import { TRAMITE_TIPOLOGIAS, isValidTipologia } from './tramite-tipologias.js';

/** Roles posibles de las partes intervinientes en un trámite. */
export type ParteRol =
  | 'comprador'
  | 'vendedor'
  | 'heredero'
  | 'adjudicatario'
  | 'representante_legal'
  | 'importador';

export interface ParteRequerida {
  rol: ParteRol;
  label: string;
  obligatorio: boolean;
  ayuda?: string;
}

/**
 * Configuración del "adquirente": la parte primaria que captura el paso 3 del
 * wizard. Hoy ese paso se llama "comprador"; según la tipología representa al
 * heredero, adjudicatario o representante legal.
 */
export interface AdquirenteConfig {
  rol: ParteRol;
  /** Encabezado del paso 3 y etiqueta del actor en la UI. */
  label: string;
  ayuda?: string;
}

/** Estado/contexto de un paso del wizard (1..5) para una tipología dada. */
export interface PasoTipologia {
  paso: number;
  /** Título contextual del paso para la tipología (puede diferir del genérico). */
  titulo: string;
  /** Si el paso es relevante para esta tipología (todos aplican hoy; futuro-proof). */
  aplica: boolean;
  /** Matiz normativo/operativo del paso para la tipología. */
  nota?: string;
}

export interface TipologiaJourney {
  codigo: string; // === TRAMITE_TIPOLOGIAS[].codigo
  nombre: string;
  adquirente: AdquirenteConfig;
  /** Vendedor obligatorio en partes + pre-vuelo (solo compraventa directa). */
  vendedorRequerido: boolean;
  /** Todas las partes del journey (incluye al adquirente y, si aplica, vendedor). */
  partes: ParteRequerida[];
  /** Matriz de los 5 pasos del wizard contextualizada a la tipología. */
  pasos: PasoTipologia[];
  /**
   * TRAM-TIPO-02: banner de compliance contextual (matices legales/aduaneros). Es la
   * FUENTE ÚNICA del banner del wizard (`TipologiaContextBanner` lo consume vía
   * `getTipologiaCompliance`). `undefined` = sin banner.
   */
  compliance?: TipologiaCompliance;
}

/** Banner de compliance contextual por tipología (titulo + cuerpo + tono visual). */
export interface TipologiaCompliance {
  titulo: string;
  cuerpo: string;
  tono: 'info' | 'warn';
}

const COMPRADOR: ParteRequerida = {
  rol: 'comprador',
  label: 'Comprador',
  obligatorio: true,
  ayuda: 'Adquirente de la propiedad (parte que recibe el vehículo).',
};
const VENDEDOR: ParteRequerida = {
  rol: 'vendedor',
  label: 'Vendedor',
  obligatorio: true,
  ayuda: 'Titular saliente que transfiere la propiedad (compraventa directa).',
};

export const TIPOLOGIA_JOURNEYS: TipologiaJourney[] = [
  {
    codigo: 'traspaso_standard',
    nombre: 'Traspaso estándar',
    adquirente: { rol: 'comprador', label: 'Comprador', ayuda: 'Adquirente de la propiedad.' },
    vendedorRequerido: true,
    partes: [COMPRADOR, VENDEDOR],
    pasos: [
      { paso: 1, titulo: 'Consulta VIN', aplica: true, nota: 'Pre-vuelo SOAT/SIMIT/RUNT del vehículo y de ambas partes (comprador y vendedor).' },
      { paso: 2, titulo: 'Documentos', aplica: true, nota: 'Contrato de compraventa autenticado + impronta + SOAT.' },
      { paso: 3, titulo: 'Comprador y vendedor', aplica: true, nota: 'Ambas partes obligatorias: comprador (entra) y vendedor (sale).' },
      { paso: 4, titulo: 'Identidad', aplica: true, nota: 'Validación de identidad del comprador.' },
      { paso: 5, titulo: 'Generar FUR', aplica: true, nota: 'FUR de traspaso → envío a tránsito.' },
    ],
  },
  {
    codigo: 'sucesion',
    nombre: 'Traspaso por sucesión',
    adquirente: { rol: 'heredero', label: 'Heredero / adjudicatario', ayuda: 'Persona a quien se adjudica el vehículo en la sucesión.' },
    vendedorRequerido: false,
    partes: [
      { rol: 'heredero', label: 'Heredero / adjudicatario', obligatorio: true, ayuda: 'Adjudicatario del vehículo según sentencia o escritura.' },
    ],
    pasos: [
      { paso: 1, titulo: 'Consulta VIN', aplica: true, nota: 'Vehículo del causante; NO hay vendedor (titular fallecido).' },
      { paso: 2, titulo: 'Documentos', aplica: true, nota: 'Sentencia/escritura de adjudicación + registro civil de defunción.' },
      { paso: 3, titulo: 'Heredero / adjudicatario', aplica: true, nota: 'Solo el adjudicatario; sin parte vendedora.' },
      { paso: 4, titulo: 'Identidad', aplica: true, nota: 'Validación de identidad del heredero adjudicatario.' },
      { paso: 5, titulo: 'Generar FUR', aplica: true, nota: 'FUR de traspaso por sucesión.' },
    ],
    compliance: { titulo: 'Traspaso por sucesión', cuerpo: 'No aplica parte vendedora: el titular fallecido no se consulta en RUNT como vendedor.', tono: 'info' },
  },
  {
    codigo: 'remate',
    nombre: 'Adjudicación / remate judicial',
    adquirente: { rol: 'adjudicatario', label: 'Adjudicatario', ayuda: 'Persona favorecida con la adjudicación en el remate.' },
    vendedorRequerido: false,
    partes: [
      { rol: 'adjudicatario', label: 'Adjudicatario', obligatorio: true, ayuda: 'Adjudicatario identificado en el oficio del juzgado.' },
    ],
    pasos: [
      { paso: 1, titulo: 'Consulta VIN', aplica: true, nota: 'Vehículo rematado; transferencia por orden judicial.' },
      { paso: 2, titulo: 'Documentos', aplica: true, nota: 'Acta de remate + oficio del juzgado (obligatorio, identifica placa/VIN).' },
      { paso: 3, titulo: 'Adjudicatario', aplica: true, nota: 'Solo el adjudicatario; sin vendedor particular.' },
      { paso: 4, titulo: 'Identidad', aplica: true, nota: 'Validación de identidad del adjudicatario.' },
      { paso: 5, titulo: 'Generar FUR', aplica: true, nota: 'FUR con soporte del oficio judicial.' },
    ],
    compliance: { titulo: 'Remate judicial', cuerpo: 'FLIT no valida la legalidad del remate. Verifique acta y oficio del juzgado antes de radicar.', tono: 'warn' },
  },
  {
    codigo: 'importacion',
    nombre: 'Importación / primera matrícula',
    adquirente: { rol: 'importador', label: 'Importador', ayuda: 'Persona (natural o jurídica) que importa y matricula el vehículo por primera vez.' },
    vendedorRequerido: false,
    partes: [
      { rol: 'importador', label: 'Importador', obligatorio: true, ayuda: 'Importador titular de la declaración de importación; sin vendedor previo.' },
    ],
    pasos: [
      { paso: 1, titulo: 'Consulta VIN', aplica: true, nota: 'Primera matrícula: inscripción RUNT del vehículo aún no existe (unknown hasta radicar).' },
      { paso: 2, titulo: 'Documentos', aplica: true, nota: 'Factura de importación + levante aduanero + declaración de importación (DIAN).' },
      { paso: 3, titulo: 'Importador', aplica: true, nota: 'Solo el importador; sin vendedor (vehículo nuevo a Colombia).' },
      { paso: 4, titulo: 'Identidad', aplica: true, nota: 'Validación de identidad del importador.' },
      { paso: 5, titulo: 'Generar FUR', aplica: true, nota: 'FUR de matrícula inicial por importación.' },
    ],
    compliance: { titulo: 'Importación / primera matrícula', cuerpo: 'Los documentos aduaneros son responsabilidad del gestor. Revise factura, levante y declaración DIAN.', tono: 'info' },
  },
  {
    codigo: 'flota_corporativa',
    nombre: 'Flota corporativa',
    adquirente: { rol: 'representante_legal', label: 'Representante legal', ayuda: 'Representante legal de la persona jurídica titular de la flota.' },
    vendedorRequerido: false,
    partes: [
      { rol: 'representante_legal', label: 'Representante legal', obligatorio: true, ayuda: 'Acreditado en cámara de comercio (≤30 días) + poder archivado.' },
    ],
    pasos: [
      { paso: 1, titulo: 'Consulta VIN', aplica: true, nota: 'Por vehículo de la flota (puede repetirse por lote).' },
      { paso: 2, titulo: 'Documentos', aplica: true, nota: 'Cámara de comercio + RUT + poder del representante legal.' },
      { paso: 3, titulo: 'Representante legal', aplica: true, nota: 'Persona jurídica; sin vendedor particular.' },
      { paso: 4, titulo: 'Identidad', aplica: true, nota: 'Validación de identidad del representante legal.' },
      { paso: 5, titulo: 'Generar FUR', aplica: true, nota: 'FUR a nombre de la persona jurídica.' },
    ],
  },
];

const JOURNEY_BY_CODE = new Map(TIPOLOGIA_JOURNEYS.map((j) => [j.codigo, j]));

/** Adquirente por defecto cuando no hay tipología (preserva el flujo "comprador"). */
const DEFAULT_ADQUIRENTE: AdquirenteConfig = { rol: 'comprador', label: 'Comprador', ayuda: 'Adquirente de la propiedad.' };

/** Journey de la tipología, o `undefined` si el código no existe. */
export function getJourney(codigo: string | null | undefined): TipologiaJourney | undefined {
  if (!codigo) return undefined;
  return JOURNEY_BY_CODE.get(codigo);
}

/**
 * ¿La tipología exige una parte VENDEDORA? Solo `traspaso_standard` (compraventa
 * directa). Sin tipología (o desconocida) → `false` (retrocompatible: el flujo
 * actual no captura vendedor).
 */
export function vendedorRequerido(codigo: string | null | undefined): boolean {
  return getJourney(codigo)?.vendedorRequerido ?? false;
}

/** Config del adquirente (etiqueta del paso 3). Cae al genérico "Comprador". */
export function getAdquirente(codigo: string | null | undefined): AdquirenteConfig {
  return getJourney(codigo)?.adquirente ?? DEFAULT_ADQUIRENTE;
}

/** Partes requeridas del journey (vacío si no hay tipología). */
export function getPartesRequeridas(codigo: string | null | undefined): ParteRequerida[] {
  return getJourney(codigo)?.partes ?? [];
}

/** Contexto de un paso del wizard para una tipología, o `undefined`. */
export function getPasoTipologia(codigo: string | null | undefined, paso: number): PasoTipologia | undefined {
  return getJourney(codigo)?.pasos.find((p) => p.paso === paso);
}

/**
 * TRAM-TIPO-02: banner de compliance contextual por tipología (FUENTE ÚNICA, la
 * consume `TipologiaContextBanner`). `null` si la tipología no tiene matiz legal.
 */
export function getTipologiaCompliance(codigo: string | null | undefined): TipologiaCompliance | null {
  return getJourney(codigo)?.compliance ?? null;
}

/** Banner del paso 5 (Expediente) como texto plano, derivado de `compliance`. */
export function getBannerExpediente(codigo: string | null | undefined): string | null {
  const c = getJourney(codigo)?.compliance;
  return c ? `${c.titulo} — ${c.cuerpo}` : null;
}

/**
 * Detecta desincronización entre el catálogo de checklist y la matriz de journeys.
 * Devuelve la lista de inconsistencias (vacío = sano). Sin side-effects: los tests
 * lo invocan; el módulo NO lanza al importarse.
 */
export function matrizDriftIssues(): string[] {
  const issues: string[] = [];
  for (const j of TIPOLOGIA_JOURNEYS) {
    if (!isValidTipologia(j.codigo)) {
      issues.push(`journey '${j.codigo}' no existe en TRAMITE_TIPOLOGIAS`);
    }
    if (j.vendedorRequerido && !j.partes.some((p) => p.rol === 'vendedor' && p.obligatorio)) {
      issues.push(`journey '${j.codigo}' marca vendedorRequerido pero no lista vendedor obligatorio`);
    }
    if (!j.partes.some((p) => p.rol === j.adquirente.rol)) {
      issues.push(`journey '${j.codigo}' no incluye su adquirente '${j.adquirente.rol}' en partes`);
    }
    if (j.pasos.length !== 5) {
      issues.push(`journey '${j.codigo}' debe tener 5 pasos (tiene ${j.pasos.length})`);
    }
  }
  for (const t of TRAMITE_TIPOLOGIAS) {
    if (!JOURNEY_BY_CODE.has(t.codigo)) {
      issues.push(`tipología '${t.codigo}' del catálogo no tiene journey en la matriz`);
    }
  }
  return issues;
}
