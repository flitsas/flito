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
 * **La frontera del GESTOR no se decide aquí.** La aplica `detalle()` de SOAT antes de llegar a esta
 * función, devolviendo 404 y no 403 (AC4). Lo que sí se decide aquí es **qué rol tiene derecho a ver
 * este bloque**, que es otra pregunta y se resuelve en `soportesDeSoat`.
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
 * Quién puede ver el comprobante del pago PSE dentro de la lista de un SOAT (HU #11678, AC5).
 *
 * `auditor` **no está**, y esa ausencia es el arreglo de un bloqueante. `GET /flito/soat/:id/soportes`
 * está abierta a `admin`, `proveedor` y `auditor`, y `buscarConAcceso` solo aplica frontera de
 * pertenencia cuando el rol es `proveedor`: para auditoría no filtra nada. Sin esta lista, colgar el
 * comprobante de esa respuesta le daba a `auditor` el comprobante de CUALQUIER boleta conciliada con
 * solo conocer el id de uno de sus SOAT —y con la URL ya firmada—, que es más fácil que la puerta de
 * atrás que esta misma HU cerró en `flito-bolsas` y `flito-revisiones`.
 *
 * Manda el AC5 («proveedor y auditor → 403»), la matriz de `docs/ux/flito-conciliacion.md` y el
 * ADR-0006 §7.5: el comprobante es de Administración, Financiera y —solo el suyo— el gestor.
 * Auditoría sigue viendo todo lo demás del SOAT exactamente como antes.
 *
 * `financiera` figura aquí por coherencia con la matriz aunque hoy el router de SOAT no la admita:
 * la lista describe QUIÉN tiene derecho al dato, no por qué puerta entra.
 */
const ROLES_COMPROBANTE_PSE: readonly string[] = ['admin', 'financiera', 'proveedor'];

/**
 * Qué documentos de un SOAT puede ver una compañía CLIENTE (Feature #11912).
 *
 * Está VACÍA, y una lista vacía es la respuesta correcta hoy, no un hueco: los únicos soportes que
 * cuelgan de un SOAT son la FACTURA DE LA ASEGURADORA o del proveedor —el precio al que FLITO
 * compra, con su enlace ya firmado— y el comprobante del pago PSE de la boleta, que además ya está
 * fuera por `ROLES_COMPROBANTE_PSE`. Ninguno de los dos es del cliente.
 *
 * **Es una allowlist y no un `if (rol === cliente) return []`** justamente porque la HU #11916 va a
 * dejarle descargar SU PÓLIZA cuando el SOAT esté `pagado`: ese día se añade aquí el tipo de la
 * póliza y la puerta se abre de una línea, en el sitio donde se ve lo que se abre. Con el atajo,
 * abrirla exigiría rehacer esta decisión desde cero — o, peor, quitar el `if` entero.
 *
 * Mismo gesto que `ROLES_COMPROBANTE_PSE`, unas líneas más arriba: se enumera quién SÍ, nunca quién
 * no, para que lo que se añada mañana quede fuera por defecto.
 */
export const TIPOS_SOPORTE_VISIBLES_CLIENTE: readonly string[] = [];

/** El rol del canal Cliente. Mismo literal que `shared/middleware/canal-cliente.ts`. */
const ROL_CLIENTE = 'cliente';

/** Lo que la ruta sabe del actor y esta consulta necesita para decidir qué bloques devuelve. */
export interface ActorSoporte {
  rol: string;
}

/**
 * Comprobantes del SOAT (la factura de la aseguradora). El SOAT se ancla al VIN, no al trámite.
 *
 * Desde la HU #11678 la lista trae además el comprobante del pago PSE de la boleta que lo concilió,
 * con `origen: 'conciliacion'`. Se AÑADE, no sustituye: la factura de la aseguradora que el gestor
 * ya veía sigue en la lista y sigue con `origen: 'soat'`, que es lo que el AC3 exige literalmente.
 *
 * Sale por aquí y no por una ruta nueva (que es lo que proponía el ADR-0006 §7.5) porque el AC3 pide
 * este endpoint por su nombre, y porque la ruta que lo sirve ya resuelve la PERTENENCIA: pasa por
 * `detalle()`, o sea por la frontera del gestor, y devuelve enlaces firmados.
 *
 * **`actor` es obligatorio y no tiene valor por defecto.** Un opcional habría hecho que el bloque
 * más sensible de la lista se incluyera por olvido —que es exactamente cómo se coló el bloqueante—;
 * exigirlo obliga a cada llamador nuevo a decidir a quién está sirviendo. Y la consulta ni se emite
 * cuando el rol no tiene derecho: no se lee lo que no se va a devolver.
 */
export async function soportesDeSoat(
  soatId: string, actor: ActorSoporte,
): Promise<SoporteVista[]> {
  // `null` = sin recorte por tipo (los 11 roles internos: ven lo de siempre). Para el `cliente` es
  // la allowlist, y si está vacía la consulta ni se emite — no se lee lo que no se va a devolver, el
  // mismo criterio que ya aplica la línea de abajo con el comprobante PSE.
  const tiposVisibles = actor.rol === ROL_CLIENTE ? TIPOS_SOPORTE_VISIBLES_CLIENTE : null;
  const [propios, conciliacion] = await Promise.all([
    tiposVisibles !== null && tiposVisibles.length === 0
      ? Promise.resolve([] as SoporteVista[])
      : porRegistro(flitoSoportes.soatId, soatId, 'soat'),
    ROLES_COMPROBANTE_PSE.includes(actor.rol) ? comprobanteDeConciliacion(soatId) : [],
  ]);
  const visibles = tiposVisibles === null ? propios : propios.filter((s) => tiposVisibles.includes(s.tipo));
  return ordenar([...visibles, ...conciliacion]);
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
