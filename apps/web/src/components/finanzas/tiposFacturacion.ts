// Reporte de costos — tipos de la vista de facturación electrónica (HU #11337).
//
// Viven aquí y no dentro de un componente porque los comparten tres: los contadores, la ficha y la
// página. Un tipo declarado dentro del componente que lo pinta obliga a duplicarlo en cuanto un
// segundo sitio lo necesita, y de las dos copias siempre hay una que se queda vieja.

import type { SiigoEstadoDian, SiigoEstadoReporte } from '@operaciones/shared-types';

/** Lo que el servidor sabe de la factura de un trámite. Espeja `FacturacionDeTramite` del API. */
export interface FacturacionTramite {
  tramiteId: string;
  facturaId: string;
  numero: string | null;
  estadoEmision: string;
  estado: SiigoEstadoReporte;
  estadoDian: SiigoEstadoDian | null;
  /**
   * `false` = la factura se creó en Siigo pero NO se envió a la DIAN, porque el ambiente no es
   * producción (A6). Lo resuelve el servidor: aquí no se deduce del ambiente, para que la regla
   * viva en un solo sitio.
   *
   * Cambia dos cosas de la pantalla, y las dos mentirían si se ignorara: `estadoDian` se queda en
   * `null` para siempre —el sondeo no la mira— y el correo al cliente no se puede reenviar.
   */
  timbrada: boolean;
  /** El motivo del rechazo, en lenguaje operativo. `null` si no aplica o no se sabe. */
  motivo: string | null;
  /**
   * `true` = se preguntó por el motivo y no se pudo obtener.
   *
   * Distinto de `motivo === null`, y esa diferencia es el AC4: uno significa «no hay causa que
   * mostrar» y el otro «la hay, pero todavía no la tenemos». Enseñar un hueco en ambos casos haría
   * que quien opera no supiera si esperar o ir a mirar a Siigo Nube.
   */
  motivoPendiente: boolean;
  verificadoEn: string | null;
  cufe: string | null;
  documentos: { pdf: boolean; xml: boolean };
  correo: { veces: number; ultimoEnviadoEn: string | null };
}

/** Los contadores del reporte. Uno por estado más el total, para poder cuadrar. */
export type ResumenFacturacion = Record<SiigoEstadoReporte, number> & { total: number };

/** Un acta de envío, tal como la devuelve el API del correo (HU #11334). */
export interface EnvioRegistro {
  id: string;
  origen: 'emision' | 'reenvio';
  resultado: 'enviado' | 'fallido' | 'no_realizado';
  destinatarios: { correo: string; origen: string }[];
  motivo: string | null;
  codigo: string | null;
  creadoEn: string;
}

export interface ResumenEnvios {
  facturaId: string;
  veces: number;
  vecesEnviado: number;
  ultimo: EnvioRegistro | null;
  ultimoEnviado: EnvioRegistro | null;
  envios: EnvioRegistro[];
}

/**
 * Colores por estado. Se mapea a los tonos del sistema, no a colores sueltos.
 *
 * `rechazado` y `fallido` comparten el rojo a propósito: los dos exigen que alguien haga algo. Lo
 * que los distingue —quién lo rompió y dónde se arregla— lo dice la etiqueta, no el color; pedirle
 * al color que transmita esa diferencia sería pedirle demasiado a alguien que mira de reojo.
 */
export const TONO_ESTADO: Record<SiigoEstadoReporte, 'neutro' | 'espera' | 'exito' | 'alerta'> = {
  no_enviado: 'neutro',
  // `encolado` comparte el tono de espera con `en_proceso` (HU #11328): los dos significan «va en
  // camino, no hagas nada». Lo que los separa —si ya existe documento— lo dice la etiqueta.
  encolado: 'espera',
  en_proceso: 'espera',
  emitido: 'espera',
  aceptado: 'exito',
  rechazado: 'alerta',
  anulado: 'neutro',
  fallido: 'alerta',
};

/** Fecha corta y legible. `null` se pinta como raya, nunca como «Invalid Date». */
export function fechaCorta(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
}
