// Contrato `ia-consumo` v1 (docs/contratos/ia-consumo.v1.md, ADR-0047) — catálogos cerrados.
//
// Los textos son los del contrato, compartidos con FLIT 2.0: NO se renombran aquí. Un uso nuevo se
// agrega a la tabla «modulo / proceso — FLITO» del contrato Y a `PROCESOS_IA_FLITO`, en el mismo PR.

export const ORIGENES_IA = ['usuario', 'job', 'sistema', 'ciudadano', 'prueba_prompt'] as const;
export type OrigenIa = (typeof ORIGENES_IA)[number];

export const RESULTADOS_IA = [
  'exito', 'rate_limit', 'timeout', 'red', 'error_proveedor', 'rechazado', 'respuesta_invalida', 'cancelado', 'no_configurado',
] as const;
export type ResultadoIa = (typeof RESULTADOS_IA)[number];

export const TIPOS_TAREA_IA = [
  'ocr', 'clasificacion', 'orientacion', 'particion', 'chat', 'redaccion', 'captcha', 'validacion_identidad', 'recorte', 'salud',
] as const;
export type TipoTareaIa = (typeof TIPOS_TAREA_IA)[number];

export const PROVEEDORES_IA = ['anthropic', 'openai', 'kimi', 'deepseek', 'tesseract'] as const;
export type ProveedorIa = (typeof PROVEEDORES_IA)[number];

/** Tabla «modulo / proceso — FLITO» del contrato. La clave es el proceso (único dentro de FLITO). */
export const PROCESOS_IA_FLITO = {
  ocr_factura_soat: { modulo: 'soat', tipoTarea: 'ocr' },
  ocr_recibo_impuesto: { modulo: 'impuestos', tipoTarea: 'ocr' },
  ocr_recibo_caja: { modulo: 'impuestos', tipoTarea: 'ocr' },
  ocr_derecho_tramite: { modulo: 'tramites', tipoTarea: 'ocr' },
  ocr_factura_venta: { modulo: 'tramites', tipoTarea: 'ocr' },
  ocr_vehiculo_factura_venta: { modulo: 'tramites', tipoTarea: 'ocr' },
  ocr_comprobante_universal: { modulo: 'tramites', tipoTarea: 'ocr' },
  particion_consolidado: { modulo: 'tramites', tipoTarea: 'particion' },
  ocr_documento: { modulo: 'tramites', tipoTarea: 'ocr' },
  copiloto_checklist: { modulo: 'tramites', tipoTarea: 'chat' },
  validar_identidad: { modulo: 'identidad', tipoTarea: 'validacion_identidad' },
  recortar_cedula: { modulo: 'identidad', tipoTarea: 'recorte' },
  ocr_vehiculo: { modulo: 'vehiculos', tipoTarea: 'ocr' },
  ocr_declaracion_impuesto: { modulo: 'vehiculos', tipoTarea: 'ocr' },
  ocr_pagina_drive: { modulo: 'drive', tipoTarea: 'ocr' },
  ocr_cedula: { modulo: 'runt', tipoTarea: 'ocr' },
  captcha: { modulo: 'runt', tipoTarea: 'captcha' },
  salud_modelos: { modulo: 'sistema', tipoTarea: 'salud' },
  // Agregados al implementar (mismo PR, contrato actualizado):
  ocr_fecha_expedicion: { modulo: 'bolsas_documentos', tipoTarea: 'ocr' },
  chat: { modulo: 'dr_flit', tipoTarea: 'chat' },
} as const satisfies Record<string, { modulo: string; tipoTarea: TipoTareaIa }>;

export type ProcesoIaFlito = keyof typeof PROCESOS_IA_FLITO;

/** `{ modulo, proceso, tipoTarea }` de un proceso del catálogo, para abrir el contexto sin repetir la tabla. */
export function procesoIa(proceso: ProcesoIaFlito): { modulo: string; proceso: ProcesoIaFlito; tipoTarea: TipoTareaIa } {
  const { modulo, tipoTarea } = PROCESOS_IA_FLITO[proceso];
  return { modulo, proceso, tipoTarea };
}

export const MODULO_DESCONOCIDO = 'desconocido';
export const PROCESO_DESCONOCIDO = 'desconocido';
