// FLITO SOAT — las TRECE celdas de pago y trazabilidad del archivo AMPLIADO (Bug #12642).
//
// Vive aparte de `flito-soat.export.service.ts` por dos motivos. El primero es de tamaño: aquel
// archivo ya roza el techo de `max-lines` del CI. El segundo es la frontera que este Bug conserva: la
// proyección de las 27 columnas del gestor (`COLUMNAS_CONSULTA`) NO cambia, y lo que aquí se declara
// solo entra en la consulta cuando la ruta pidió `incluirPago: true` y el actor tiene
// `soat.excel.exportar_pago`. Quien lea el servicio ve una proyección; quien lea este archivo ve la
// otra mitad, y las dos se suman en un solo sitio (`construirFilasExportSoat`).
//
// El registro de acceso (Ley 1581 art. 17) lo pone la RUTA. Este archivo no toca `req`.

import { and, eq, inArray } from 'drizzle-orm';
import { ESTADO_SOAT_LABEL, TipoSoporte, type EstadoSoat } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoProveedoresSoat, flitoSoat, flitoSoportes } from '../../db/schema.js';
import {
  celdaFecha, celdaInstante, celdaNumero, celdaTexto, type CeldasPagoSoat,
} from '../../shared/export/cola-flito-excel.js';

/**
 * Lo que la proyección del export SUMA cuando el archivo sale ampliado, escrito campo a campo
 * (RN-E1 sigue: sigue sin haber `select()` sin proyección, y `extraccion` sigue fuera).
 *
 * `proveedorNombre` sale de `flito_proveedores_soat`, que `conJoinsCola` ya une con `leftJoin`: cero
 * joins nuevos. `gestionOperaciones` decide si la celda `Gestor` dice el proveedor o «Operaciones»
 * —cuando Operaciones asume, `proveedor_soat_id` se CONSERVA para poder devolverlo (HU #11152), así
 * que mirar solo el nombre publicaría al proveedor equivocado—.
 */
export const COLUMNAS_PAGO_SOAT = {
  estado: flitoSoat.estado,
  enviadoEn: flitoSoat.enviadoEn,
  pagadoEn: flitoSoat.pagadoEn,
  valorPagado: flitoSoat.valorPagado,
  numeroPoliza: flitoSoat.numeroPoliza,
  gestionOperaciones: flitoSoat.gestionOperaciones,
  proveedorNombre: flitoProveedoresSoat.nombre,
  motivoRechazo: flitoSoat.motivoRechazo,
  estadoVigencia: flitoSoat.estadoVigencia,
  venceEl: flitoSoat.venceEl,
  polizaRunt: flitoSoat.polizaRunt,
  verificadaEn: flitoSoat.verificadaEn,
  createdAt: flitoSoat.createdAt,
} as const;

/**
 * Lo que devuelve esa proyección. A mano —y no derivado— por la nullabilidad, igual que `Comprador`
 * en el servicio: casi todo es opcional en la tabla y la ausencia tiene que llegar a la celda vacía.
 * Las fechas se tipan `Date | string | null`: la columna es `timestamptz`, pero una fila que venga de
 * una expresión cruda llega como la cadena del driver.
 */
export interface FilaConsultaPagoSoat {
  estado: string;
  enviadoEn: Date | string | null;
  pagadoEn: Date | string | null;
  valorPagado: string | null;
  numeroPoliza: string | null;
  gestionOperaciones: boolean;
  proveedorNombre: string | null;
  motivoRechazo: string | null;
  estadoVigencia: string | null;
  venceEl: string | Date | null;
  polizaRunt: string | null;
  verificadaEn: Date | string | null;
  createdAt: Date | string | null;
}

/** Lo que la celda `Gestor` dice cuando la solicitud la gestiona Operaciones y no un proveedor. */
export const GESTOR_OPERACIONES = 'Operaciones';

/**
 * La fecha de carga del comprobante de pago de cada SOAT del lote: `flito_soportes.subido_en` de la
 * FACTURA del SOAT (`tipo = 'factura_soat'`) más reciente y no descartada.
 *
 * Consulta aparte y no un join: un SOAT puede tener varias facturas (una descartada en revisión,
 * otra válida) y un `leftJoin` multiplicaría la fila del archivo y falsearía el conteo contra el
 * tope. Se traen todas las del lote en UNA lectura y se elige la más reciente en memoria: es lo que
 * `soportesDeSoat` ya hace con «excluye descartados».
 */
export async function fechasComprobantePorSoat(ids: string[]): Promise<Map<string, Date | string>> {
  if (ids.length === 0) return new Map();
  const filas = await db.select({ soatId: flitoSoportes.soatId, subidoEn: flitoSoportes.subidoEn })
    .from(flitoSoportes)
    .where(and(
      inArray(flitoSoportes.soatId, ids),
      eq(flitoSoportes.tipo, TipoSoporte.FACTURA_SOAT),
      eq(flitoSoportes.descartado, false),
    ));
  const salida = new Map<string, Date | string>();
  for (const f of filas) {
    if (!f.soatId || !f.subidoEn) continue;
    const previa = salida.get(f.soatId);
    if (!previa || new Date(f.subidoEn).getTime() > new Date(previa).getTime()) salida.set(f.soatId, f.subidoEn);
  }
  return salida;
}

/** La etiqueta legible del estado (`ESTADO_SOAT_LABEL`), o el código tal cual si el enum creció. */
function etiquetaEstado(estado: string): string {
  return ESTADO_SOAT_LABEL[estado as EstadoSoat] ?? estado;
}

/**
 * Las trece celdas de pago de UNA fila. Sin pago (`pendiente`, `solicitado`) las de pago van VACÍAS
 * —nunca `0` ni «—»— y las de trazabilidad (estado, creación, gestor) siempre se llenan.
 */
export function celdasPagoSoat(f: FilaConsultaPagoSoat, comprobanteEn: Date | string | null): CeldasPagoSoat {
  return {
    estado: etiquetaEstado(f.estado),
    fechaSolicitud: celdaInstante(f.enviadoEn),
    fechaPago: celdaInstante(f.pagadoEn),
    valorPagado: celdaNumero(f.valorPagado),
    numeroPoliza: celdaTexto(f.numeroPoliza),
    gestor: f.gestionOperaciones ? GESTOR_OPERACIONES : celdaTexto(f.proveedorNombre),
    motivoNovedad: celdaTexto(f.motivoRechazo),
    vigenciaRunt: celdaTexto(f.estadoVigencia),
    venceEl: celdaFecha(f.venceEl),
    polizaRunt: celdaTexto(f.polizaRunt),
    verificadaEn: celdaInstante(f.verificadaEn),
    fechaCreacion: celdaInstante(f.createdAt),
    fechaCargaComprobante: celdaInstante(comprobanteEn),
  };
}
