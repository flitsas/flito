// TRAM-12a — máquina de estados del trámite (lógica PURA, sin dependencias de
// infraestructura: ni db, ni métricas, ni red). Separada del servicio para que
// pueda testearse de forma aislada sin cargar el grafo de módulos pesado.

export const VALID_ESTADOS = ['borrador', 'radicado', 'en_validacion', 'documentos', 'identidad', 'aprobado', 'rechazado', 'enviado_transito', 'recibido_transito', 'placa_preasignada', 'solicitud_soat', 'soat_comprado', 'soat_verificado', 'completado'] as const;
export type TramiteEstado = typeof VALID_ESTADOS[number];

export const VALID_TRANSITIONS: Record<string, string[]> = {
  borrador: ['radicado', 'en_validacion', 'documentos', 'identidad', 'aprobado', 'enviado_transito'],
  radicado: ['en_validacion', 'documentos', 'rechazado'],
  en_validacion: ['documentos', 'rechazado'],
  documentos: ['identidad', 'rechazado'],
  identidad: ['aprobado', 'rechazado'],
  aprobado: ['enviado_transito', 'rechazado'],
  rechazado: ['borrador'],
  enviado_transito: ['rechazado'],
  recibido_transito: ['placa_preasignada', 'enviado_transito', 'rechazado'],
  placa_preasignada: ['solicitud_soat', 'recibido_transito', 'rechazado'],
  solicitud_soat: ['soat_comprado'],
  soat_comprado: ['soat_verificado'],
  soat_verificado: ['completado'],
  completado: [],
};

/** ¿La transición de estado `from → to` está permitida por la máquina de estados? */
export function isValidTransition(from: string, to: string): boolean {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}
