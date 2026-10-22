// Dr. Flit — mapeo del caso de soporte a un Bug de FLIT - SOPORTE (HU #13804, Feature #13695).
// Función PURA: sin red, sin base, sin `env` (la configuración entra por parámetro). Diseño F5,
// «Mapeo a ADO» (P9-2, P9-3), verificado contra el Bug #13713 de FLIT - SOPORTE.
//
// RN-DRF-M1  `System.Title` = `[ DR. FLIT FLITO ] {título}` (prefijo constante, D3).
// RN-DRF-M2  El detalle (default `Microsoft.VSTS.TCM.ReproSteps`) es HTML con TODOS los valores del
//            usuario escapados (también el título y el área). Saltos de línea → `<br>` DESPUÉS de escapar.
//            Lleva `Ref. FLITO: DRF-<id del intento>`: estable entre reintentos de la misma clave, así
//            soporte reconoce un duplicado si una respuesta de ADO se perdió (residuo P9-11).
// RN-DRF-M3  Prioridad (default `Microsoft.VSTS.Common.Priority`): alta→1, media→2, baja→3.
//            `Microsoft.VSTS.Common.Severity` NO se envía (la severidad la pone soporte en el triage).
// RN-DRF-M4  Ambiente (default `Custom.Environment`; vacío = no se envía) = DEV | QA | PDN, del
//            `DEPLOY_ENVIRONMENT` resuelto por `dr-flit.config.ts`, nunca de `NODE_ENV`.
// RN-DRF-M5  `System.Tags` = tags base (`FLITO`) + tags de pruebas (`FLITO-PRUEBAS`) en DEV y QA.
// RN-DRF-M6  El ÁREA va en el ReproSteps. No se envían `Custom.SolutionArea`, `Custom.AffectedModule`
//            ni `System.AssignedTo` (sin asignar, D3). `System.AreaPath` solo si se configuró.
import {
  ETIQUETAS_AREA_SOPORTE, ETIQUETAS_FRECUENCIA_SOPORTE, ETIQUETAS_PRIORIDAD_SOPORTE,
  ETIQUETAS_AMBIENTE_DESPLIEGUE, type AmbienteDespliegue, type CasoSoporteDrFlit, type PrioridadSoporte,
} from '@operaciones/shared-types';

export const PREFIJO_TITULO_DRFLIT = '[ DR. FLIT FLITO ]';
export const RUTA_TITULO = '/fields/System.Title';
export const RUTA_TAGS = '/fields/System.Tags';
export const RUTA_AREA_PATH = '/fields/System.AreaPath';

export const PRIORIDAD_ADO: Readonly<Record<PrioridadSoporte, number>> = Object.freeze({ alta: 1, media: 2, baja: 3 });

export interface OperacionAdo { op: 'add'; path: string; value: unknown }

export interface ConfigMapeoAdo {
  campoDetalle: string;
  campoPrioridad: string;
  /** Vacío = no se envía el ambiente. */
  campoAmbiente: string;
  /** Vacío o ausente = no se envía `System.AreaPath`. */
  areaPath?: string;
  tags: string;
  tagsPruebas: string;
}

export interface ContextoMapeo {
  intentoId: number;
  ambiente: AmbienteDespliegue;
  fecha: Date;
  adjuntosCantidad: number;
}

/** Escapa los cinco caracteres con significado en HTML. Todo valor del usuario pasa por aquí. */
export function escaparHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escapa y luego convierte los saltos de línea en `<br>` (el orden importa: el `<br>` es nuestro). */
export function textoHtml(v: string): string {
  return escaparHtml(v).replace(/\r\n|\r|\n/g, '<br>');
}

/** Fecha del reporte en hora de Colombia, sin depender de la zona del proceso. */
export function fechaBogota(d: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

export function refFlito(intentoId: number): string {
  return `DRF-${intentoId}`;
}

/** Tags separados por `;` como los guarda ADO (`FLITO; FLITO-PRUEBAS`). */
export function tagsPara(ambiente: AmbienteDespliegue, cfg: Pick<ConfigMapeoAdo, 'tags' | 'tagsPruebas'>): string {
  const partes = [cfg.tags];
  if (ambiente !== 'PDN' && cfg.tagsPruebas) partes.push(cfg.tagsPruebas);
  return partes.map((t) => t.trim()).filter(Boolean).join('; ');
}

/** ReproSteps en HTML escapado (RN-DRF-M2). */
export function reproStepsHtml(caso: CasoSoporteDrFlit, ctx: ContextoMapeo): string {
  const fila = (etiqueta: string, valor: string) => `<tr><td><b>${etiqueta}</b></td><td>${valor}</td></tr>`;
  const adjuntos = ctx.adjuntosCantidad > 0 ? `Sí (${ctx.adjuntosCantidad})` : 'No';
  const filas = [
    fila('Título', textoHtml(caso.titulo)),
    fila('Área', escaparHtml(ETIQUETAS_AREA_SOPORTE[caso.area])),
    fila('Nombre', textoHtml(caso.contacto.nombre)),
    fila('Correo', textoHtml(caso.contacto.correo)),
    fila('Teléfono', caso.contacto.telefono ? textoHtml(caso.contacto.telefono) : '—'),
    fila('Fecha del reporte', escaparHtml(fechaBogota(ctx.fecha))),
    fila('Ambiente', escaparHtml(`${ctx.ambiente} (${ETIQUETAS_AMBIENTE_DESPLIEGUE[ctx.ambiente]})`)),
    fila('Frecuencia', escaparHtml(ETIQUETAS_FRECUENCIA_SOPORTE[caso.frecuencia])),
    fila('Prioridad indicada', escaparHtml(ETIQUETAS_PRIORIDAD_SOPORTE[caso.prioridad])),
    fila('Adjuntos', adjuntos),
  ].join('');
  return '<p><b>Caso radicado desde Dr. Flit (FLITO)</b></p>'
    + `<table>${filas}</table>`
    + `<p><b>Detalle</b><br>${textoHtml(caso.detalle)}</p>`
    + `<p><b>Resultado esperado</b><br>${textoHtml(caso.resultadoEsperado)}</p>`
    + `<p>Ref. FLITO: ${refFlito(ctx.intentoId)}</p>`;
}

/** Operaciones json-patch (`add`) del create del Bug. */
export function construirBugSoporte(
  caso: CasoSoporteDrFlit, ctx: ContextoMapeo, cfg: ConfigMapeoAdo,
): OperacionAdo[] {
  const ops: OperacionAdo[] = [
    { op: 'add', path: RUTA_TITULO, value: `${PREFIJO_TITULO_DRFLIT} ${caso.titulo}` },
    { op: 'add', path: `/fields/${cfg.campoDetalle}`, value: reproStepsHtml(caso, ctx) },
    { op: 'add', path: `/fields/${cfg.campoPrioridad}`, value: PRIORIDAD_ADO[caso.prioridad] },
  ];
  if (cfg.campoAmbiente) ops.push({ op: 'add', path: `/fields/${cfg.campoAmbiente}`, value: ctx.ambiente });
  const tags = tagsPara(ctx.ambiente, cfg);
  if (tags) ops.push({ op: 'add', path: RUTA_TAGS, value: tags });
  if (cfg.areaPath) ops.push({ op: 'add', path: RUTA_AREA_PATH, value: cfg.areaPath });
  return ops;
}
