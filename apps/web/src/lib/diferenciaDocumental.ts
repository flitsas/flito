// Reporte de costos — el valor documental de un concepto y su diferencia contra la tarifa (o el
// catálogo), en texto (HU #12655, Feature #12607, Épica #12245).
//
// Todo lo que aquí vive es PURO y sin JSX a propósito: corre con `node --test` y es el único sitio
// donde se decide qué dice un chip, un nombre accesible, un globo, el botón de la fila, el modal y
// el aviso de éxito. La tabla y el diálogo componen estos textos; no los escriben.
//
// Qué lee (DTO `ValoresDocumentalesDeFila`, HU #12653):
//   · `origenes.<concepto>`  → 'documental' | 'tarifa' | null (null = no configurado o autogestionado).
//   · `valorDocumental.<concepto>` → el comprobante aplicado contra la tarifa de referencia, con
//     `diferencia = valor − tarifaReferencia` (tolerancia 0) y, si alguien la aceptó, quién/cuándo/por qué.
//
// Reglas que este módulo fija (y que los mutantes del gate B tienen que tumbar):
//   · El mapa de origen NO se invierte: 'documental' → «Documento», 'tarifa' → «Tarifa».
//   · El signo NUNCA se pierde: «−$20.000» lleva el menos tipográfico (U+2212) pegado al «$».
//   · En servicios adicionales se dice «Difiere del catálogo», y la diferencia se resuelve APLICANDO
//     el comprobante con su tipo de servicio (Bug #12913: ese valor entra a la puente del trámite),
//     no aceptándola: la nota lo dice en vez de insinuar que aceptar suma.
//   · Una fila cuyo `origenes.<concepto>` es null NO lleva chips ni acción, aunque traiga
//     `valorDocumental` (AC3: la compañía autogestiona; el comprobante existe pero no se cobra).

import type { OrigenValor, ValorDocumentalConcepto, ValoresDocumentalesDeFila } from '@operaciones/shared-types';

export type ConceptoDocumental = 'tramiteDigital' | 'logistica' | 'serviciosAdicionales';

/** Los tres conceptos, en el orden en que la tabla los pinta y el modal los lista. */
export const CONCEPTOS_DOCUMENTALES: readonly ConceptoDocumental[] = ['tramiteDigital', 'logistica', 'serviciosAdicionales'];

/** Nombre del concepto como arranca una frase; en minúscula va dentro de «Aceptar diferencia de …». */
export const NOMBRE_CONCEPTO: Record<ConceptoDocumental, string> = {
  tramiteDigital: 'Trámite digital', logistica: 'Logística', serviciosAdicionales: 'Servicios adicionales',
};
const enMinuscula = (c: ConceptoDocumental) => NOMBRE_CONCEPTO[c].toLowerCase();

export const TEXTO_ORIGEN: Record<'documental' | 'tarifa', string> = { documental: 'Documento', tarifa: 'Tarifa' };
export const ROTULO_ACEPTAR = 'Aceptar diferencia';
export const ROTULO_ACEPTANDO = 'Aceptando…';
export const ROTULO_CON_DIFERENCIAS = 'Con diferencias';
export const AYUDA_CON_DIFERENCIAS = 'Solo trámites con al menos una diferencia sin aceptar.';
export const VACIO_CON_DIFERENCIAS = 'No hay trámites con diferencias sin aceptar en este filtro. Desmarca «Con diferencias» o amplía el periodo.';
export const SIN_TARIFA = 'Sin tarifa configurada';
/** Servicios adicionales (UX slim Bug #12913): aceptar no suma; lo que suma es aplicar el pago con su tipo. */
export const NOTA_SERVICIOS_ADICIONALES = 'El costo usa el valor del comprobante; el catálogo queda como referencia';
export const MOTIVO_DIFERENCIA_MIN = 5;
export const MOTIVO_DIFERENCIA_MAX = 500;

/** `$ 95.000`, el mismo formato del reporte para los absolutos. */
export const pesosReporte = (n: number) =>
  n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

/**
 * `+$5.000` / `−$20.000`: signo SIEMPRE escrito y pegado (V3), menos tipográfico. El cero no se
 * pinta con «+»: una diferencia de 0 no es una diferencia, y quien la llame se lleva «$0».
 */
export function importeConSigno(n: number): string {
  const abs = Math.abs(n).toLocaleString('es-CO', { maximumFractionDigits: 0 });
  return `${n < 0 ? '−' : n > 0 ? '+' : ''}$${abs}`;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * «16 sep 2026», hora de Colombia; `null` o basura → `null` (el tramo se omite, nunca «null»).
 * Tabla propia y no `toLocaleDateString`: el ICU de `es-CO` vierte «16 de sept de 2026», que no es
 * el copy del slim y cambia entre versiones de Node y de navegador.
 */
export function fechaDiferencia(iso: string | null): string | null {
  if (!iso) return null;
  const f = new Date(iso);
  if (Number.isNaN(f.getTime())) return null;
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(f);
  const de = (t: string) => Number(partes.find((p) => p.type === t)?.value);
  return `${de('day')} ${MESES[de('month') - 1]} ${de('year')}`;
}

/** Chip de origen (AC1): «Documento» / «Tarifa»; sin origen, sin chip. Servicios adicionales nunca lo lleva. */
export function textoOrigen(origen: OrigenValor | undefined): string | null {
  return origen === 'documental' || origen === 'tarifa' ? TEXTO_ORIGEN[origen] : null;
}

/** Lo que el comprobante dijo: la tarifa más la diferencia, o la diferencia entera si no había tarifa. */
export const valorDelComprobante = (vd: Pick<ValorDocumentalConcepto, 'tarifaReferencia' | 'diferencia'>): number =>
  (vd.tarifaReferencia ?? 0) + (vd.diferencia ?? 0);

/** «N.º FS-1023 · 12 sep 2026», con lo que haya; `null` si no hay ni número ni fecha. */
export function referenciaComprobante(vd: Pick<ValorDocumentalConcepto, 'numero' | 'fecha'>): string | null {
  const partes = [vd.numero ? `N.º ${vd.numero}` : null, fechaDiferencia(vd.fecha)].filter((p): p is string => p !== null);
  return partes.length ? partes.join(' · ') : null;
}

export interface ChipDiferencia {
  texto: string;
  tono: 'warning' | 'neutral';
  /** El nombre accesible de la marca (`aria-label`): lo dice TODO sin depender de hover ni de tono. */
  accesible: string;
  /** El globo de una línea que se revela por foco/puntero. */
  globo: string;
  pendiente: boolean;
}

/**
 * Chip de diferencia (AC2). `null` cuando no hay comprobante aplicado, cuando el API no marcó
 * diferencia o cuando la diferencia es 0 con tarifa (el documento cuadra: solo va «Documento»).
 */
export function textoDiferencia(concepto: ConceptoDocumental, vd: ValorDocumentalConcepto | null | undefined): ChipDiferencia | null {
  if (!vd || vd.diferencia === null) return null;
  if (vd.diferencia === 0 && vd.tarifaReferencia !== null) return null;
  const nombre = NOMBRE_CONCEPTO[concepto];
  const signo = importeConSigno(vd.diferencia);
  const comprobante = pesosReporte(valorDelComprobante(vd));
  const ref = referenciaComprobante(vd);

  if (vd.aceptada) {
    const quien = vd.aceptadaPorNombre ?? 'alguien';
    const cuando = fechaDiferencia(vd.aceptadaEn);
    const motivo = vd.aceptadaMotivo ? `«${vd.aceptadaMotivo}»` : null;
    const globo = [`Aceptada por ${quien}`, cuando, motivo].filter(Boolean).join(' · ');
    const frase = [`${nombre}: diferencia ${signo} aceptada por ${quien}`, cuando ? ` el ${cuando}` : '', motivo ? `: ${motivo}` : ''].join('');
    return { texto: `Diferencia aceptada ${signo}`, tono: 'neutral', accesible: `${frase}.`, globo, pendiente: false };
  }

  if (vd.tarifaReferencia === null) {
    return {
      texto: SIN_TARIFA, tono: 'warning', pendiente: true,
      accesible: `${nombre}: el comprobante dice ${comprobante} y no hay tarifa configurada. Diferencia ${signo}. Sin aceptar.`,
      globo: [`Comprobante ${comprobante}`, SIN_TARIFA, ref].filter(Boolean).join(' · '),
    };
  }

  const referencia = pesosReporte(vd.tarifaReferencia);
  if (concepto === 'serviciosAdicionales') {
    return {
      texto: `Difiere del catálogo ${signo}`, tono: 'warning', pendiente: true,
      accesible: `${nombre}: el comprobante dice ${comprobante} y el catálogo suma ${referencia}. Diferencia ${signo}. Sin aceptar. ${NOTA_SERVICIOS_ADICIONALES}.`,
      globo: [`Comprobante ${comprobante}`, `Catálogo ${referencia}`, ref, NOTA_SERVICIOS_ADICIONALES].filter(Boolean).join(' · '),
    };
  }
  return {
    texto: `Difiere de tarifa ${signo}`, tono: 'warning', pendiente: true,
    accesible: `${nombre}: el comprobante dice ${comprobante} y la tarifa ${referencia}. Diferencia ${signo}. Sin aceptar.`,
    globo: [`Comprobante ${comprobante}`, `Tarifa ${referencia}`, ref].filter(Boolean).join(' · '),
  };
}

/** Tolerante a filas que no traigan el bloque (mocks viejos): sin datos, sin chips. */
type FilaDocumental = Partial<ValoresDocumentalesDeFila>;

export const origenDe = (f: FilaDocumental, c: ConceptoDocumental): OrigenValor =>
  c === 'serviciosAdicionales' ? null : (f.origenes?.[c] ?? null);

export const valorDocumentalDe = (f: FilaDocumental, c: ConceptoDocumental): ValorDocumentalConcepto | null =>
  f.valorDocumental?.[c] ?? null;

/**
 * Si el concepto de ESTA fila lleva marcas (AC3, mutante 9): en trámite digital y logística manda
 * `origenes.<concepto>` —null es «no configurado» o «autogestiona», y ahí no hay nada que decir
 * aunque exista un comprobante—; en servicios adicionales no hay origen y manda el comprobante.
 */
export const conceptoMarcable = (f: FilaDocumental, c: ConceptoDocumental): boolean =>
  c === 'serviciosAdicionales' || origenDe(f, c) !== null;

/** Los conceptos de la fila con diferencia SIN aceptar, en el orden de la tabla. */
export function pendientesDe(f: FilaDocumental): ConceptoDocumental[] {
  return CONCEPTOS_DOCUMENTALES.filter((c) => conceptoMarcable(f, c) && textoDiferencia(c, valorDocumentalDe(f, c))?.pendiente === true);
}

const listaDe = (conceptos: readonly ConceptoDocumental[]) => conceptos.map(enMinuscula).join(' y ');

/** «Aceptar diferencia de trámite digital y logística de FLIT-10234» (AC5). */
export const nombreAccesibleAceptar = (idFlit: string, conceptos: readonly ConceptoDocumental[]) =>
  `${ROTULO_ACEPTAR} de ${listaDe(conceptos)} de ${idFlit}`;

/** «Trámite digital +$15.000 · Logística −$5.000»: el `title` del botón. */
export const tituloAceptar = (f: FilaDocumental, conceptos: readonly ConceptoDocumental[]) =>
  conceptos.map((c) => `${NOMBRE_CONCEPTO[c]} ${importeConSigno(valorDocumentalDe(f, c)?.diferencia ?? 0)}`).join(' · ');

/** «Diferencia de trámite digital de FLIT-10234 aceptada.» / «Diferencias de … aceptadas.» */
export const avisoAceptadas = (idFlit: string, conceptos: readonly ConceptoDocumental[]) =>
  conceptos.length === 1
    ? `Diferencia de ${listaDe(conceptos)} de ${idFlit} aceptada.`
    : `Diferencias de ${listaDe(conceptos)} de ${idFlit} aceptadas.`;

/** «Aceptar diferencia · FLIT-10234 · ABC123» (sin placa, sin el tramo). */
export const tituloModalAceptar = (idFlit: string, placa: string | null) =>
  [ROTULO_ACEPTAR, idFlit, placa].filter(Boolean).join(' · ');

/** Las dos líneas y la diferencia de cada concepto en el modal (§4 del slim). */
export function lineaModal(concepto: ConceptoDocumental, vd: ValorDocumentalConcepto): { linea1: string; diferencia: string; linea2: string | null } {
  const comprobante = `Comprobante ${pesosReporte(valorDelComprobante(vd))}`;
  const contra = vd.tarifaReferencia === null
    ? SIN_TARIFA
    : `${concepto === 'serviciosAdicionales' ? 'Catálogo' : 'Tarifa'} ${pesosReporte(vd.tarifaReferencia)}`;
  const ref = referenciaComprobante(vd);
  const nota = concepto === 'serviciosAdicionales' ? `${NOTA_SERVICIOS_ADICIONALES}.` : null;
  const linea2 = [ref, nota].filter(Boolean).join(' · ') || null;
  return { linea1: `${comprobante} · ${contra}`, diferencia: importeConSigno(vd.diferencia ?? 0), linea2 };
}

/** El motivo vale cuando, sin espacios en los bordes, tiene entre 5 y 500 caracteres. */
export const motivoDiferenciaValido = (motivo: string): boolean => {
  const n = motivo.trim().length;
  return n >= MOTIVO_DIFERENCIA_MIN && n <= MOTIVO_DIFERENCIA_MAX;
};
