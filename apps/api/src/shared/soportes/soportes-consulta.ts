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

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { EstadoSoat, TipoSoporte } from '@operaciones/shared-types';
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
 *
 * `tipos` acota la lectura a los tipos que el actor puede ver (`null` = sin recorte, los once roles
 * internos). Va en la CONSULTA y no solo en un filtro posterior por la razón que la HU #11913 dejó
 * escrita para el comprobante PSE: no se lee lo que no se va a devolver. Quien llama sigue filtrando
 * además en memoria, y esa redundancia es deliberada — así la garantía no depende de que este
 * `where` siga aquí, y se puede afirmar sin una base de datos real.
 */
async function porRegistro(
  columna: typeof flitoSoportes.soatId | typeof flitoSoportes.impuestoId
    | typeof flitoSoportes.derechoId | typeof flitoSoportes.siigoFacturaId,
  registroId: string,
  origen: string,
  tipos: readonly string[] | null = null,
): Promise<SoporteVista[]> {
  const filas = await db.select({
    id: flitoSoportes.id, tipo: flitoSoportes.tipo, nombreArchivo: flitoSoportes.nombreArchivo,
    storageKey: flitoSoportes.storageKey, subidoEn: flitoSoportes.subidoEn,
  }).from(flitoSoportes)
    .where(and(
      eq(columna, registroId),
      eq(flitoSoportes.descartado, false),
      ...(tipos === null ? [] : [inArray(flitoSoportes.tipo, [...tipos])]),
    ));
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

/** Una entrada de la allowlist del canal Cliente: qué tipo, desde qué estado, y por qué. */
export interface SoporteVisibleCliente {
  tipo: TipoSoporte;
  /**
   * `null` = visible siempre que el cliente pueda ver la solicitud. Un estado = **solo** ahí.
   *
   * Es la mitad que sostiene el AC3 de la #11916 («sin `pagado` no hay descarga»): sin este campo,
   * abrir la póliza habría sido añadir un tipo a una lista plana, y la condición de estado habría
   * acabado en un `if` de la ruta —lejos de la lista, donde nadie la ve al revisar qué se abrió—.
   */
  soloEn: EstadoSoat | null;
  /** Qué se rompe si se quita. Mismo gesto que `RutaCliente.porque` en `canal-cliente.ts`. */
  porque: string;
}

/**
 * Qué documentos de un SOAT puede ver una compañía CLIENTE, y desde qué estado (Feature #11912,
 * HU #11916 AC2/AC3).
 *
 * La #11913 la dejó VACÍA y escribió que la #11916 abriría la póliza «de una línea, en el sitio
 * donde se ve lo que se abre». Esto es esa línea. Sigue siendo una **allowlist** —se enumera lo que
 * SÍ, nunca lo que no—, igual que `ROLES_COMPROBANTE_PSE` unas líneas más arriba, para que un tipo
 * de soporte nuevo quede fuera por defecto sin que nadie tenga que acordarse.
 *
 * ── El hecho medido que hay que saber antes de tocar esta lista ──────────────────────────────────
 *
 * **En este sistema la póliza y «la factura del proveedor» son LA MISMA FILA.** No hay un
 * `TipoSoporte.POLIZA`: el documento que el gestor sube por `POST /:id/factura` es
 * `factura_soat`, el prompt del OCR lo llama «PÓLIZA/FACTURA DE SOAT» y de él se extraen número de
 * póliza, aseguradora, vigencia y prima. La propia HU #11916 lo nombra así en su descripción («el
 * OCR de la factura-póliza») y su AC2 pide el PDF de «la póliza cargada por OCR». Por eso abrir
 * `factura_soat` **es** el AC2, y no una ampliación de alcance.
 *
 * **Y la consecuencia que hay que asumir con los ojos abiertos:** ese PDF trae la PRIMA TOTAL, que
 * es el mismo dato que la #11913 quitó del DTO del cliente (`CAMPOS_SOLO_INTERNOS.valorPagado`,
 * «lo que FLITO pagó por la póliza, frente a lo que le factura al cliente»). El campo sigue fuera
 * de la respuesta JSON; el importe entra por el documento. Es una decisión de producto ya tomada
 * —el SOAT es del vehículo del cliente y su póliza es suya—, no un descuido de esta lista, y queda
 * escrita aquí para que quien la revise no tenga que deducirla. Si un día se quisiera lo contrario,
 * lo que hace falta es un documento distinto para el cliente, no un filtro más.
 *
 * ── Lo que NO entra, y por qué ───────────────────────────────────────────────────────────────────
 *
 *   · `comprobante_pse` — el pago de la boleta con la que FLITO concilia. Ya está fuera dos veces:
 *     por `ROLES_COMPROBANTE_PSE`, que tampoco gana `cliente` (ADR-0008 §6), y por no estar aquí.
 *   · `factura_electronica_pdf` / `_xml`, `recibo_impuesto*` — no cuelgan de un SOAT, así que hoy
 *     no pueden aparecer en esta lista; están nombrados para que quien ate uno a `soat_id` mañana
 *     tenga que venir a decidirlo aquí en vez de que se cuele.
 */
export const TIPOS_SOPORTE_VISIBLES_CLIENTE: readonly SoporteVisibleCliente[] = [
  {
    tipo: TipoSoporte.FACTURA_SOAT,
    soloEn: EstadoSoat.PAGADO,
    porque: 'Es la póliza (AC2). Antes de `pagado` no hay nada que descargar y el AC3 lo prohíbe '
      + 'expresamente: el documento existe en la fila desde que el gestor lo sube, pero mientras el '
      + 'OCR no lo haya validado no es la prueba de nada — puede acabar descartado en la cola de '
      + 'revisión y ser sustituido por otro.',
  },
  {
    tipo: TipoSoporte.FACTURA_VENTA,
    soloEn: null,
    porque: 'Es SU PROPIO adjunto: la única forma de que un `factura_venta` cuelgue de un `soat_id` '
      + 'es que lo subiera el propio cliente al radicar (`POST /cliente`) o al subsanar (`PATCH '
      + '/:id/solicitud`) — la del flujo de trámite cuelga de `flito_impuestos`, nunca de un SOAT. '
      + 'Sin esta entrada, la pantalla de corregir un rechazo no puede responder «¿qué factura '
      + 'tengo cargada?», que es la carga que la #11914 dejó declarada. No trae ningún dato de la '
      + 'operación: lo escribió él. Sin `soloEn` porque el momento en que hace falta es justo '
      + 'cuando la solicitud NO está pagada.',
  },
];

/** El rol del canal Cliente. Mismo literal que `shared/middleware/canal-cliente.ts`. */
const ROL_CLIENTE = 'cliente';

/**
 * Los tipos que este cliente puede ver AHORA, resueltos contra el estado de la solicitud.
 *
 * Se recorre la lista y no se escribe una segunda copia de la regla: el día que una entrada gane un
 * `soloEn`, la puerta se cierra sin tocar nada más.
 */
function tiposVisiblesCliente(estadoSoat: string): readonly string[] {
  return TIPOS_SOPORTE_VISIBLES_CLIENTE
    .filter((s) => s.soloEn === null || s.soloEn === estadoSoat)
    .map((s) => s.tipo);
}

/** Lo que la ruta sabe del actor y esta consulta necesita para decidir qué bloques devuelve. */
export interface ActorSoporte {
  rol: string;
  /**
   * El estado del SOAT que se está mirando, tal como lo devolvió la consulta que ya autorizó el
   * acceso (`detalle()` → `buscarConAcceso()`). **Obligatorio**, por lo mismo que `rol`: un campo
   * opcional habría dejado que el llamador siguiente se olvidara de decir en qué estado está la
   * fila, y el AC3 se apoya entero en ese dato. No se vuelve a leer de la base porque sería una
   * segunda lectura del mismo hecho, que además podría discrepar de la que autorizó.
   */
  estadoSoat: string;
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
 *
 * Desde la HU #11916 `actor` lleva además el ESTADO del SOAT, y por la misma razón: para el
 * `cliente` la lista de tipos depende de él (la póliza solo en `pagado`, AC2/AC3). Los otros once
 * roles no lo miran — su recorte por tipo sigue siendo `null`, «lo de siempre».
 */
export async function soportesDeSoat(
  soatId: string, actor: ActorSoporte,
): Promise<SoporteVista[]> {
  // `null` = sin recorte por tipo (los 11 roles internos: ven lo de siempre). Para el `cliente` es
  // la allowlist RESUELTA CONTRA EL ESTADO, y si en este estado no le toca ningún tipo la consulta
  // ni se emite — no se lee lo que no se va a devolver, el mismo criterio que ya aplica la línea de
  // abajo con el comprobante PSE. Esa rama no es teórica: basta con vaciar la lista, o con que un
  // día todas las entradas lleven `soloEn`.
  const tiposVisibles = actor.rol === ROL_CLIENTE ? tiposVisiblesCliente(actor.estadoSoat) : null;
  const [propios, conciliacion] = await Promise.all([
    tiposVisibles !== null && tiposVisibles.length === 0
      ? Promise.resolve([] as SoporteVista[])
      : porRegistro(flitoSoportes.soatId, soatId, 'soat', tiposVisibles),
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
