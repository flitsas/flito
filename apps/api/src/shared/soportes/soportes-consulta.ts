// Consulta de soportes (documentos) para enseñarlos, vengan del flujo que vengan.
//
// Nació dentro de finanzas.routes como el cuerpo de GET /tramites/:id/soportes, y se saca aquí
// porque las mismas listas hacen falta desde tres pantallas más —Gestión de trámites, el detalle
// de un SOAT y el detalle de un impuesto— y cada una entra con un rol distinto. Lo que cambia
// entre ellas es QUIÉN puede pedirlas y con qué frontera, que es cosa de la ruta; lo que NO debe
// cambiar es cómo se arma la lista. Dos copias de este armado se separan en cuanto una gane un
// origen nuevo y la otra no, y el síntoma es un documento que existe y no se ve.
//
// Todas las URLs son enlaces firmados y con caducidad (`/api/files?...`): el storage no se expone.

import { and, eq, isNotNull } from 'drizzle-orm';
import { TipoSoporte } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  flitoConciliacionLineas, flitoDerechosTramite, flitoImpuestos, flitoLogisticaActas,
  flitoLogisticaDocumentos, flitoSoat, flitoSoportes, flitoTramites, siigoFacturaTramites,
} from '../../db/schema.js';
import { firmarDescargaEntidad } from '../../services/storage.js';

/** Un documento listo para enseñar: con su enlace ya firmado. */
export interface SoporteVista {
  id: string;
  /** De qué flujo viene: soat · impuesto · derecho · logistica. Lo usa la UI para agrupar. */
  origen: string;
  tipo: string;
  nombreArchivo: string;
  url: string;
  subidoEn: string;
}

/** Del más reciente al más antiguo: lo último cargado es lo que se viene a mirar. */
function ordenar(soportes: SoporteVista[]): SoporteVista[] {
  return soportes.sort((a, b) => b.subidoEn.localeCompare(a.subidoEn));
}

/**
 * Soportes de `flito_soportes` que cuelgan de un registro concreto (SOAT, impuesto o derecho).
 *
 * Los descartados en la cola de revisión no son evidencia de nada: quedan fuera.
 */
async function porRegistro(
  columna: typeof flitoSoportes.soatId | typeof flitoSoportes.impuestoId
    | typeof flitoSoportes.derechoId | typeof flitoSoportes.siigoFacturaId,
  registroId: string,
  origen: string,
): Promise<SoporteVista[]> {
  const filas = await db.select({
    id: flitoSoportes.id, tipo: flitoSoportes.tipo, nombreArchivo: flitoSoportes.nombreArchivo,
    storageKey: flitoSoportes.storageKey, subidoEn: flitoSoportes.subidoEn,
  }).from(flitoSoportes)
    .where(and(eq(columna, registroId), eq(flitoSoportes.descartado, false)));
  return filas.map((f) => ({
    id: f.id, origen, tipo: f.tipo, nombreArchivo: f.nombreArchivo,
    url: firmarDescargaEntidad(f.storageKey), subidoEn: f.subidoEn.toISOString(),
  }));
}

/**
 * Comprobante del pago PSE de la boleta en la que este SOAT se concilió (HU #11678, AC3).
 *
 * El puente son tres saltos —`flito_conciliacion_lineas.soat_id` → `boleta_id` →
 * `flito_soportes.conciliacion_boleta_id`— porque el comprobante cuelga de la BOLETA: la financiera
 * paga una boleta que agrupa N SOAT y el portal emite un solo archivo. Es exactamente el mismo caso
 * que la factura electrónica, que tampoco cuelga del trámite sino de la factura, y se resuelve igual.
 *
 * `conciliada_en IS NOT NULL` no es decoración: una línea sin sellar es una fila de un cuadre que
 * todavía no movió un peso, y su boleta puede acabar descartada. Solo el pago consumado tiene
 * comprobante que enseñar.
 *
 * **Quién puede llamar a esto NO se decide aquí.** Lo decide la ruta, y en el caso del gestor lo
 * decide `detalle()` de SOAT, que aplica la frontera 404-no-403 antes de llegar a esta función
 * (AC4). Este archivo arma listas; no es una superficie de autorización.
 */
async function comprobanteDeConciliacion(soatId: string): Promise<SoporteVista[]> {
  const filas = await db.select({
    id: flitoSoportes.id, tipo: flitoSoportes.tipo, nombreArchivo: flitoSoportes.nombreArchivo,
    storageKey: flitoSoportes.storageKey, subidoEn: flitoSoportes.subidoEn,
  }).from(flitoConciliacionLineas)
    .innerJoin(
      flitoSoportes,
      eq(flitoSoportes.conciliacionBoletaId, flitoConciliacionLineas.boletaId),
    )
    .where(and(
      eq(flitoConciliacionLineas.soatId, soatId),
      isNotNull(flitoConciliacionLineas.conciliadaEn),
      eq(flitoSoportes.tipo, TipoSoporte.COMPROBANTE_PSE),
      eq(flitoSoportes.descartado, false),
    ));
  return filas.map((f) => ({
    id: f.id, origen: 'conciliacion', tipo: f.tipo, nombreArchivo: f.nombreArchivo,
    url: firmarDescargaEntidad(f.storageKey), subidoEn: f.subidoEn.toISOString(),
  }));
}

/**
 * Comprobantes del SOAT (la factura de la aseguradora). El SOAT se ancla al VIN, no al trámite.
 *
 * Desde la HU #11678 la lista trae además el comprobante del pago PSE de la boleta que lo concilió,
 * con `origen: 'conciliacion'`. Se AÑADE, no sustituye: la factura de la aseguradora que el gestor
 * ya veía sigue en la lista y sigue con `origen: 'soat'`, que es lo que el AC3 exige literalmente.
 *
 * Sale por aquí y no por una ruta nueva (que es lo que proponía el ADR-0006 §7.5) porque el AC3 pide
 * este endpoint por su nombre, y porque la ruta que lo sirve ya resuelve el permiso: pasa por
 * `detalle()`, o sea por la frontera del gestor, y devuelve enlaces firmados. Una ruta más habría
 * sido una superficie más que proteger para enseñar lo mismo.
 */
export async function soportesDeSoat(soatId: string): Promise<SoporteVista[]> {
  const [propios, conciliacion] = await Promise.all([
    porRegistro(flitoSoportes.soatId, soatId, 'soat'),
    comprobanteDeConciliacion(soatId),
  ]);
  return ordenar([...propios, ...conciliacion]);
}

/** Comprobantes del impuesto (el recibo del organismo). */
export async function soportesDeImpuesto(impuestoId: string): Promise<SoporteVista[]> {
  return ordenar(await porRegistro(flitoSoportes.impuestoId, impuestoId, 'impuesto'));
}

/** Comprobantes del derecho de tránsito (el recibo del organismo). */
export async function soportesDeDerecho(derechoId: string): Promise<SoporteVista[]> {
  return ordenar(await porRegistro(flitoSoportes.derechoId, derechoId, 'derecho'));
}

/**
 * TODOS los documentos de un trámite, de los cuatro orígenes, en una sola respuesta.
 *
 * Aquí no se elige: se devuelve lo que haya. Lo que no exista simplemente no aparece. Devuelve
 * `null` —y no una lista vacía— cuando el trámite no existe, para que la ruta pueda distinguir
 * «no hay documentos» de «ese trámite no es de este sistema» y responder 404.
 *
 * Los tres primeros viven en `flito_soportes`; logística guarda los suyos aparte —la foto del
 * documento entregado y el acta firmada— y por eso se consultan por separado (HU #11025).
 */
export async function soportesDeTramite(tramiteId: string): Promise<SoporteVista[] | null> {
  const [t] = await db.select({
    soatId: flitoTramites.soatId, impuestoId: flitoImpuestos.id, derechoId: flitoDerechosTramite.id,
  }).from(flitoTramites)
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .where(eq(flitoTramites.id, tramiteId)).limit(1);

  if (!t) return null;

  const salida: SoporteVista[] = [];

  // Logística: la foto del documento entregado y el acta de entrega con sus firmas. No están en
  // `flito_soportes` porque nacen del flujo de entrega, no de una carga de comprobantes.
  const docsLogistica = await db.select({
    id: flitoLogisticaDocumentos.id, tipo: flitoLogisticaDocumentos.tipo,
    foto: flitoLogisticaDocumentos.fotoStorageKey, createdAt: flitoLogisticaDocumentos.createdAt,
    actaPdf: flitoLogisticaActas.pdfStorageKey, actaEn: flitoLogisticaActas.createdAt,
    actaId: flitoLogisticaActas.id,
  }).from(flitoLogisticaDocumentos)
    .leftJoin(flitoLogisticaActas, eq(flitoLogisticaDocumentos.actaId, flitoLogisticaActas.id))
    .where(eq(flitoLogisticaDocumentos.tramiteId, tramiteId));

  const actasVistas = new Set<string>();
  for (const d of docsLogistica) {
    if (d.foto) {
      salida.push({
        id: d.id, origen: 'logistica', tipo: d.tipo, nombreArchivo: `${d.tipo}.jpg`,
        url: firmarDescargaEntidad(d.foto), subidoEn: d.createdAt.toISOString(),
      });
    }
    // Un acta cubre varios documentos del mismo trámite: se lista una sola vez.
    if (d.actaPdf && d.actaId && !actasVistas.has(d.actaId)) {
      actasVistas.add(d.actaId);
      salida.push({
        id: d.actaId, origen: 'logistica', tipo: 'acta_entrega', nombreArchivo: 'Acta de entrega.pdf',
        url: firmarDescargaEntidad(d.actaPdf), subidoEn: (d.actaEn ?? d.createdAt).toISOString(),
      });
    }
  }

  if (t.soatId) salida.push(...await porRegistro(flitoSoportes.soatId, t.soatId, 'soat'));
  if (t.impuestoId) salida.push(...await porRegistro(flitoSoportes.impuestoId, t.impuestoId, 'impuesto'));
  if (t.derechoId) salida.push(...await porRegistro(flitoSoportes.derechoId, t.derechoId, 'derecho'));

  // El PDF y el XML de la factura electrónica (HU #11335). Se consultan aparte y no con los otros
  // tres porque el trámite no los alcanza por una columna suya: cuelgan de la factura, y el puente
  // es `siigo_factura_tramites`. Solo las VIVAS —una factura fallida se reintenta y sus documentos,
  // si existieran, no son el soporte de nada.
  //
  // Que salgan por aquí es además lo que resuelve el permiso (AC6): las dos rutas que sirven esta
  // lista ya exigen acceso a Gestión de trámites o al reporte de costos, y la URL es un enlace
  // firmado con caducidad, igual que la de los demás soportes. No hay una ruta de descarga nueva
  // que proteger, que es exactamente lo que se buscaba.
  const facturas = await db.select({ facturaId: siigoFacturaTramites.facturaId })
    .from(siigoFacturaTramites)
    .where(and(
      eq(siigoFacturaTramites.tramiteId, tramiteId),
      eq(siigoFacturaTramites.activo, true),
    ));
  for (const f of facturas) {
    salida.push(...await porRegistro(flitoSoportes.siigoFacturaId, f.facturaId, 'factura_electronica'));
  }

  return ordenar(salida);
}
