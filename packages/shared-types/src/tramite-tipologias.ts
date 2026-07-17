// EPIC TRAM-INNOV · A5 — Catálogo de tipologías de trámite + checklist dinámico.
//
// Fuente ÚNICA de verdad (el epic permite "seed SQL o JSON en repo"; elegimos
// JSON-en-repo aquí para evitar duplicación entre API y web y poder versionarlo
// con el código). La BD solo persiste, por trámite: `tipologia_codigo` y
// `checklist_estado` (overrides manuales). Las definiciones de ítems viven aquí.
//
// Consumido por:
//   - API: validación del código, cómputo de checklist y gate de envío a tránsito.
//   - Web: render del selector + checklist con progreso.
//
// `docTipo` enlaza un ítem con un tipo de documento de `tramites_documentos`
// (factura | aduana | impronta | soat | certificado_ambiental | compraventa |
// otro) para auto-marcarlo cuando el gestor sube ese documento.

export interface ChecklistItem {
  /** Identificador estable del ítem dentro de la tipología (no traducir). */
  id: string;
  /** Etiqueta visible para el gestor. */
  label: string;
  /** Si es obligatorio para enviar a tránsito (gate cuando STRICT). */
  obligatorio: boolean;
  /** Ayuda contextual / nota normativa (opcional). */
  ayuda?: string;
  /**
   * Tipo de documento que, si está subido, auto-marca este ítem.
   * Si se omite, el ítem solo se satisface con marca manual.
   */
  docTipo?: string;
}

export interface TramiteTipologia {
  codigo: string;
  nombre: string;
  descripcion: string;
  checklist: ChecklistItem[];
}

export const TRAMITE_TIPOLOGIAS: TramiteTipologia[] = [
  {
    codigo: 'traspaso_standard',
    nombre: 'Traspaso estándar',
    descripcion: 'Traspaso de propiedad entre particulares (compraventa directa).',
    checklist: [
      { id: 'contrato_compraventa', label: 'Contrato de compraventa autenticado', obligatorio: true, docTipo: 'compraventa', ayuda: 'Firmas autenticadas ante notaría de comprador y vendedor.' },
      { id: 'impronta', label: 'Impronta de motor y chasis', obligatorio: true, docTipo: 'impronta' },
      { id: 'soat', label: 'SOAT vigente', obligatorio: true, docTipo: 'soat' },
      { id: 'rtm', label: 'Revisión técnico-mecánica vigente', obligatorio: true, ayuda: 'Aplica según antigüedad del vehículo (Ley 769 Art. 52).' },
      { id: 'paz_salvo', label: 'Paz y salvo de impuestos y comparendos', obligatorio: true, ayuda: 'Impuesto vehicular al día + SIMIT sin comparendos en mora.' },
      { id: 'cedulas', label: 'Cédulas de comprador y vendedor', obligatorio: true },
      { id: 'cert_tradicion', label: 'Certificado de tradición y libertad', obligatorio: false, ayuda: 'Recomendado para verificar prendas/embargos antes de radicar.' },
    ],
  },
  {
    codigo: 'sucesion',
    nombre: 'Traspaso por sucesión',
    descripcion: 'Transferencia por fallecimiento del titular (adjudicación a herederos).',
    checklist: [
      { id: 'adjudicacion', label: 'Sentencia o escritura de adjudicación sucesoral', obligatorio: true, ayuda: 'Documento que acredita la adjudicación del vehículo al heredero.' },
      { id: 'registro_defuncion', label: 'Registro civil de defunción del titular', obligatorio: true },
      { id: 'paz_salvo_dian', label: 'Paz y salvo de impuestos y sucesión (DIAN)', obligatorio: true },
      { id: 'soat', label: 'SOAT vigente', obligatorio: true, docTipo: 'soat' },
      { id: 'impronta', label: 'Impronta de motor y chasis', obligatorio: true, docTipo: 'impronta' },
      { id: 'cedulas_herederos', label: 'Cédulas de herederos / adjudicatario', obligatorio: true },
      { id: 'rtm', label: 'Revisión técnico-mecánica vigente', obligatorio: false },
    ],
  },
  {
    codigo: 'remate',
    nombre: 'Adjudicación / remate judicial',
    descripcion: 'Transferencia por adjudicación en proceso judicial o remate.',
    checklist: [
      { id: 'acta_remate', label: 'Acta de remate / auto aprobatorio del juzgado', obligatorio: true, docTipo: 'acta_remate', ayuda: 'Acta de la diligencia de remate o auto que la aprueba.' },
      { id: 'oficio_juzgado', label: 'Oficio del juzgado ordenando el traspaso', obligatorio: true, docTipo: 'oficio_judicial', ayuda: 'Debe identificar placa/VIN y al adjudicatario.' },
      { id: 'paz_salvo_remate', label: 'Paz y salvo de impuestos y comparendos', obligatorio: true },
      { id: 'soat', label: 'SOAT vigente', obligatorio: true, docTipo: 'soat' },
      { id: 'impronta', label: 'Impronta de motor y chasis', obligatorio: true, docTipo: 'impronta' },
      { id: 'cedula_adjudicatario', label: 'Cédula del adjudicatario', obligatorio: true },
    ],
  },
  {
    codigo: 'importacion',
    nombre: 'Importación / primera matrícula',
    descripcion: 'Vehículo importado — primera inscripción en Colombia.',
    checklist: [
      { id: 'factura_importacion', label: 'Factura de importación / venta internacional', obligatorio: true, docTipo: 'factura', ayuda: 'Factura comercial del proveedor o importador.' },
      { id: 'levante_aduana', label: 'Levante aduanero / manifiesto', obligatorio: true, docTipo: 'aduana', ayuda: 'Autorización de levante de la DIAN tras la importación.' },
      { id: 'declaracion_importacion', label: 'Declaración de importación (DIAN)', obligatorio: true, docTipo: 'declaracion_aduana', ayuda: 'Formulario de declaración de importación (DIAN/MUISCA) con subpartida arancelaria.' },
      { id: 'impronta', label: 'Impronta de motor y chasis', obligatorio: true, docTipo: 'impronta' },
      { id: 'soat', label: 'SOAT vigente', obligatorio: true, docTipo: 'soat' },
      { id: 'cert_ambiental', label: 'Certificado de emisiones / ambiental', obligatorio: false, docTipo: 'certificado_ambiental' },
      { id: 'cedula_importador', label: 'Documento del importador', obligatorio: true, ayuda: 'Cédula (PN) o NIT + cámara de comercio (PJ) del importador.' },
      { id: 'rtm', label: 'Revisión técnico-mecánica (si aplica antigüedad)', obligatorio: false },
    ],
  },
  {
    codigo: 'flota_corporativa',
    nombre: 'Flota corporativa',
    descripcion: 'Matrícula o traspaso a nombre de persona jurídica (vehículos de flota).',
    checklist: [
      { id: 'camara_comercio', label: 'Certificado de existencia y representación legal (≤30 días)', obligatorio: true, ayuda: 'Cámara de comercio reciente que acredite al representante legal.' },
      { id: 'rut', label: 'RUT de la empresa', obligatorio: true },
      { id: 'poder_rep_legal', label: 'Poder o autorización del representante legal', obligatorio: true, ayuda: 'Mandato archivado en el expediente antes de actuar (cumplimiento RUNT).' },
      { id: 'factura', label: 'Factura de venta', obligatorio: true, docTipo: 'factura' },
      { id: 'aduana', label: 'Manifiesto de importación / aduana', obligatorio: true, docTipo: 'aduana' },
      { id: 'soat', label: 'SOAT vigente (por vehículo)', obligatorio: true, docTipo: 'soat' },
      { id: 'impronta', label: 'Impronta (por vehículo)', obligatorio: true, docTipo: 'impronta' },
      { id: 'cert_ambiental', label: 'Certificado de emisiones / ambiental', obligatorio: false, docTipo: 'certificado_ambiental' },
    ],
  },
];

const TIPOLOGIA_BY_CODE = new Map(TRAMITE_TIPOLOGIAS.map((t) => [t.codigo, t]));

/** Devuelve la tipología por código, o `undefined` si no existe. */
export function getTipologia(codigo: string | null | undefined): TramiteTipologia | undefined {
  if (!codigo) return undefined;
  return TIPOLOGIA_BY_CODE.get(codigo);
}

/** ¿El código es una tipología válida del catálogo? */
export function isValidTipologia(codigo: string | null | undefined): boolean {
  return !!codigo && TIPOLOGIA_BY_CODE.has(codigo);
}

/** Override organismo × tipología (TRAM-MT-02 F2). Persistido en BD como JSON. */
export interface ChecklistOverride {
  /** Ítems adicionales exclusivos del STT (ids nuevos). */
  add?: ChecklistItem[];
  /** IDs del catálogo base que este STT no exige. */
  hide?: string[];
  /** IDs que pasan a obligatorios aunque en base sean opcionales. */
  require?: string[];
}

/**
 * Fusiona checklist nacional con override de organismo.
 * Función PURA — sin IO. Usada por API gate y wizard paso 5.
 */
export function mergeChecklist(
  base: ChecklistItem[],
  override: ChecklistOverride | null | undefined,
): ChecklistItem[] {
  if (!override) return base.map((i) => ({ ...i }));

  const hidden = new Set(override.hide ?? []);
  const requireSet = new Set(override.require ?? []);

  const merged = base
    .filter((i) => !hidden.has(i.id))
    .map((i) => (requireSet.has(i.id) ? { ...i, obligatorio: true } : { ...i }));

  const seen = new Set(merged.map((i) => i.id));
  for (const item of override.add ?? []) {
    if (!seen.has(item.id)) {
      merged.push({ ...item });
      seen.add(item.id);
    }
  }

  return merged;
}

export type ChecklistEstado = Record<string, boolean>;

export interface ChecklistItemComputed extends ChecklistItem {
  /** Satisfecho = marcado manualmente O documento `docTipo` ya subido. */
  satisfecho: boolean;
  /** Origen de la satisfacción (para UI). */
  via: 'manual' | 'documento' | null;
}

export interface ChecklistResultado {
  codigo: string;
  nombre: string;
  items: ChecklistItemComputed[];
  total: number;
  satisfechos: number;
  obligatoriosTotal: number;
  obligatoriosSatisfechos: number;
  /** IDs de obligatorios aún sin satisfacer (bloquean envío a tránsito si STRICT). */
  faltanObligatorios: string[];
  /** Todos los obligatorios satisfechos. */
  completo: boolean;
}

/**
 * Computa el estado del checklist de un trámite combinando:
 *   - overrides manuales (`checklistEstado`)
 *   - documentos subidos (`docTipos`) que auto-marcan ítems con `docTipo`.
 *
 * Función PURA (sin IO) — testeable y compartida API/web.
 */
function computeChecklistFromItems(
  codigo: string,
  nombre: string,
  checklistItems: ChecklistItem[],
  checklistEstado: ChecklistEstado | null | undefined,
  docTipos: string[] = [],
): ChecklistResultado {
  const manual = checklistEstado || {};
  const docs = new Set(docTipos);

  const items: ChecklistItemComputed[] = checklistItems.map((it) => {
    const porDoc = !!it.docTipo && docs.has(it.docTipo);
    const porManual = manual[it.id] === true;
    const satisfecho = porDoc || porManual;
    return {
      ...it,
      satisfecho,
      via: satisfecho ? (porDoc ? 'documento' : 'manual') : null,
    };
  });

  const obligatorios = items.filter((i) => i.obligatorio);
  const faltanObligatorios = obligatorios.filter((i) => !i.satisfecho).map((i) => i.id);

  return {
    codigo,
    nombre,
    items,
    total: items.length,
    satisfechos: items.filter((i) => i.satisfecho).length,
    obligatoriosTotal: obligatorios.length,
    obligatoriosSatisfechos: obligatorios.length - faltanObligatorios.length,
    faltanObligatorios,
    completo: faltanObligatorios.length === 0,
  };
}

export function computeChecklist(
  codigo: string | null | undefined,
  checklistEstado: ChecklistEstado | null | undefined,
  docTipos: string[] = [],
): ChecklistResultado | null {
  const tip = getTipologia(codigo);
  if (!tip) return null;
  return computeChecklistFromItems(tip.codigo, tip.nombre, tip.checklist, checklistEstado, docTipos);
}

/** Checklist efectivo con override organismo × tipología (TRAM-MT-02 F2). */
export function computeChecklistWithOverride(
  codigo: string | null | undefined,
  checklistEstado: ChecklistEstado | null | undefined,
  docTipos: string[] = [],
  override?: ChecklistOverride | null,
): ChecklistResultado | null {
  const tip = getTipologia(codigo);
  if (!tip) return null;
  const effective = mergeChecklist(tip.checklist, override);
  return computeChecklistFromItems(tip.codigo, tip.nombre, effective, checklistEstado, docTipos);
}
