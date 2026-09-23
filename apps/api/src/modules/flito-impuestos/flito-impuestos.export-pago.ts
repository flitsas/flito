// FLITO Impuestos — las ONCE celdas de pago y trazabilidad del archivo AMPLIADO (Bug #12642).
//
// Gemelo de `flito-soat.export-pago.ts` y con la misma frontera: la proyección de las 27 columnas del
// gestor (`COLUMNAS_CONSULTA` del servicio) NO cambia, y lo que aquí se declara solo entra en la
// consulta cuando la ruta pidió `incluirPago: true` y el actor tiene `impuestos.excel.exportar_pago`.
//
// Lo que cambia respecto al SOAT es lo que un impuesto PAGA: hay liquidación (valor y fecha) antes del
// pago, una modalidad aplicada, una marca por diferencia, y NO hay póliza, vigencia del RUNT ni tabla
// de proveedor —el gestor de impuestos es por organismo (`flito_gestor_organismos`), así que `Gestor`
// dice «Operaciones» u «Organismo», que es la misma bifurcación del filtro `gestion` de la cola—.
//
// El registro de acceso (Ley 1581 art. 17) lo pone la RUTA. Este archivo no toca `req`.

import { ESTADO_IMPUESTO_LABEL, type EstadoImpuesto } from '@operaciones/shared-types';
import { flitoImpuestos } from '../../db/schema.js';
import {
  celdaInstante, celdaNumero, celdaTexto, type CeldasPagoImpuestos,
} from '../../shared/export/cola-flito-excel.js';

/**
 * Lo que la proyección del export SUMA cuando el archivo sale ampliado, escrito campo a campo
 * (RN-E1 sigue: sin `select()` sin proyección, y el remitente sigue fuera). Todo sale de la propia
 * `flito_impuestos`: cero joins nuevos, cero consultas nuevas.
 */
export const COLUMNAS_PAGO_IMPUESTOS = {
  estado: flitoImpuestos.estado,
  enviadoEn: flitoImpuestos.enviadoEn,
  valorLiquidado: flitoImpuestos.valorLiquidado,
  valorPagado: flitoImpuestos.valorPagado,
  pagadoEn: flitoImpuestos.pagadoEn,
  marcadoPorDiferencia: flitoImpuestos.marcadoPorDiferencia,
  modalidadAplicada: flitoImpuestos.modalidadAplicada,
  gestionOperaciones: flitoImpuestos.gestionOperaciones,
  motivoRechazo: flitoImpuestos.motivoRechazo,
  createdAt: flitoImpuestos.createdAt,
} as const;

/** Lo que devuelve esa proyección; a mano por la nullabilidad (ver `Comprador` en el servicio). */
export interface FilaConsultaPagoImpuestos {
  estado: string;
  enviadoEn: Date | string | null;
  valorLiquidado: string | null;
  valorPagado: string | null;
  pagadoEn: Date | string | null;
  marcadoPorDiferencia: boolean;
  modalidadAplicada: string;
  gestionOperaciones: boolean;
  motivoRechazo: string | null;
  createdAt: Date | string | null;
}

/** Los dos textos de la celda `Gestor`: quién lleva el impuesto según `gestion_operaciones`. */
export const GESTOR_OPERACIONES = 'Operaciones';
export const GESTOR_ORGANISMO = 'Organismo';

/** La etiqueta legible del estado (`ESTADO_IMPUESTO_LABEL`), o el código tal cual si el enum creció. */
function etiquetaEstado(estado: string): string {
  return ESTADO_IMPUESTO_LABEL[estado as EstadoImpuesto] ?? estado;
}

/**
 * Las once celdas de pago de UNA fila. Sin liquidar ni pagar (`pendiente`, `solicitado`) las de
 * importe y fecha de pago van VACÍAS —nunca `0`—; estado, modalidad, gestor, marca y creación
 * siempre se llenan porque siempre existen.
 */
export function celdasPagoImpuestos(f: FilaConsultaPagoImpuestos): CeldasPagoImpuestos {
  return {
    estado: etiquetaEstado(f.estado),
    fechaSolicitud: celdaInstante(f.enviadoEn),
    // En esta rama `flito_impuestos` aún no tiene `liquidado_en` (llega con la migración 0196 del
    // Feature 12589): la celda sale vacía y la cabecera se conserva, así el archivo no cambia de forma.
    fechaLiquidacion: null,
    valorLiquidado: celdaNumero(f.valorLiquidado),
    valorPagado: celdaNumero(f.valorPagado),
    fechaPago: celdaInstante(f.pagadoEn),
    // Texto y no booleano: «Sí»/«No» es lo que un lector filtra; un `true` crudo se importa como TRUE.
    marcadoPorDiferencia: f.marcadoPorDiferencia ? 'Sí' : 'No',
    modalidad: celdaTexto(f.modalidadAplicada),
    gestor: f.gestionOperaciones ? GESTOR_OPERACIONES : GESTOR_ORGANISMO,
    motivoNovedad: celdaTexto(f.motivoRechazo),
    fechaCreacion: celdaInstante(f.createdAt),
  };
}
