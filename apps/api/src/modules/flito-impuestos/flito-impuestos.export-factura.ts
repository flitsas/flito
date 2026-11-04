// FLITO Impuestos — las TRES celdas de la factura de venta en el Excel de la cola (HU #14294).
//
// Salen de `flito_impuestos.extraccion_factura_venta`, que lleva también la dirección del comprador y
// el VIN: por eso se proyectan `valor` y `confiable` de cada clave, una a una, y nunca el jsonb entero
// (RN-E1). Cero joins y cero consultas nuevas. Una celda solo se llena si su lectura es fiable; dudosa,
// ausente, o sin esa clave por ser una lectura anterior, va vacía y la fila sale igual.

import { sql } from 'drizzle-orm';
import { CampoDocumentoFacturaImpuesto } from '@operaciones/shared-types';
import { flitoImpuestos } from '../../db/schema.js';
import {
  celdaFecha, celdaNumero, celdaTexto, type CeldasFacturaImpuestos,
} from '../../shared/export/cola-flito-excel.js';

const valorDe = (clave: string) => sql<string | null>`${flitoImpuestos.extraccionFacturaVenta} -> ${clave} ->> 'valor'`;
const confiableDe = (clave: string) => sql<string | null>`${flitoImpuestos.extraccionFacturaVenta} -> ${clave} ->> 'confiable'`;

/** Lo que la proyección del export suma por estas celdas, en las dos variantes del archivo. */
export const COLUMNAS_FACTURA_IMPUESTOS = {
  numeroFacturaValor: valorDe(CampoDocumentoFacturaImpuesto.NUMERO_FACTURA),
  numeroFacturaConfiable: confiableDe(CampoDocumentoFacturaImpuesto.NUMERO_FACTURA),
  fechaFacturaValor: valorDe(CampoDocumentoFacturaImpuesto.FECHA_FACTURA),
  fechaFacturaConfiable: confiableDe(CampoDocumentoFacturaImpuesto.FECHA_FACTURA),
  avaluoComercialValor: valorDe(CampoDocumentoFacturaImpuesto.AVALUO_COMERCIAL),
  avaluoComercialConfiable: confiableDe(CampoDocumentoFacturaImpuesto.AVALUO_COMERCIAL),
} as const;

/** Lo que devuelve esa proyección: `->>` entrega texto, y `confiable` llega como `'true'`/`'false'`. */
export type FilaConsultaFacturaImpuestos = Record<keyof typeof COLUMNAS_FACTURA_IMPUESTOS, string | null>;

const siFiable = (valor: string | null, confiable: string | null): string | null => (confiable === 'true' ? valor : null);

/** Las tres celdas de UNA fila. Un avalúo de 0 fiable es 0: el vacío solo significa «sin dato fiable». */
export function celdasFacturaImpuestos(f: FilaConsultaFacturaImpuestos): CeldasFacturaImpuestos {
  return {
    numeroFactura: celdaTexto(siFiable(f.numeroFacturaValor, f.numeroFacturaConfiable)),
    fechaFactura: celdaFecha(siFiable(f.fechaFacturaValor, f.fechaFacturaConfiable)),
    avaluoComercial: celdaNumero(siFiable(f.avaluoComercialValor, f.avaluoComercialConfiable)),
  };
}
