// Siigo — reservar la clave y emitir la factura sin duplicarla ante la DIAN (HU #11326).
//
// Es la historia que crea documentos que **no se pueden deshacer**. Una factura aceptada por la DIAN
// existe ante la autoridad tributaria; corregirla exige una nota crédito que hoy ni siquiera sabemos
// cómo se emite (pregunta 8, abierta). Así que aquí no hay ninguna comprobación que dependa de que
// el código llegue a tiempo: **la unicidad la impone la base de datos y solo la base de datos**.
//
// EL ORDEN DE LOS PASOS ES LA MITAD DE LA HISTORIA
//
//   guardas → tercero → armado → RESERVA → POST → registro
//
// Las guardas van primero porque un rechazo no debe consumir cuota ni dejar la clave ocupada (AC7).
// El tercero y el armado van antes de la reserva porque los dos pueden fallar por datos, y fallar
// con la clave ya reservada obliga a soltarla — una transición más, y cada transición es una
// oportunidad de quedarse a medias. Así **la clave solo está reservada mientras dura el POST**, que
// es la única ventana que de verdad no se puede evitar.
//
// LAS DOS CORRECCIONES QUE NO SE PUEDEN SUAVIZAR
//
//   1. **Reclamar una fila `fallida` es un UPDATE condicionado, no un SELECT seguido de un UPDATE.**
//      `ON CONFLICT DO NOTHING` devuelve cero filas SIEMPRE que hay conflicto, sin decir por qué; si
//      después se lee el estado y se decide emitir, dos reintentos simultáneos leen los dos `fallida`
//      y emiten **dos facturas DIAN reales**. El `UPDATE … WHERE estado='fallida' RETURNING` deja que
//      PostgreSQL elija: solo uno recibe fila, y solo ese emite.
//   2. **`en_proceso` lleva arrendamiento.** Un proceso que muere entre la reserva y el `UPDATE` deja
//      la fila reservada; sin un reloj, esa clave queda bloqueada para siempre y su trámite no se
//      puede volver a facturar nunca. Pasados los minutos configurados la fila es huérfana y va a
//      reconciliación (`facturacion.reconciliacion.service.ts`), no a una segunda emisión.
//
// **Aquí no se consulta a Siigo para decidir si emitir.** Consultar y luego emitir es una carrera:
// entre las dos peticiones cabe la de otro proceso. La reserva local es la que decide; la
// reconciliación —que sí consulta— solo actúa sobre filas que ya nadie está emitiendo.

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { MotivoElegibilidad } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  flitoLiquidaciones, flitoTramites, siigoFacturas, siigoFacturaTramites, vehicles,
} from '../../db/schema.js';
import { asegurarLote } from './facturacion.lote.repo.js';
import { logger } from '../../shared/logger.js';
import { siigoRequestOrThrow } from './siigo.client.js';
import { ejecutarConResiliencia, SiigoOperacionFallida } from './siigo.resiliencia.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import { detalleTecnico, esViolacionDeUnico, sanearMensaje } from './siigo.redaccion.js';
import { modoSiigo } from './siigo.mock.js';
import { SiigoApiError } from './siigo.errors.js';
import { asegurarTercero } from './siigo.terceros.service.js';
import { evaluarElegibilidad } from './facturacion.elegibilidad.service.js';
import { parametrosDeEmision } from './config-emision.service.js';
import { resolverMapeo } from './mapeo-conceptos.service.js';
import { conceptosAplicables } from './siigo.compuerta.service.js';
import {
  armarFactura, claveIdempotencia, huellaDeTramites,
  type FacturaArmada, type MapeoPorConcepto, type TerceroResuelto, type TramiteFacturable,
} from './facturacion.armado.js';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
import type { SiigoAmbiente } from './credenciales.service.js';

const log = logger.child({ component: 'siigo.emision' });

/** Siigo recomienda 120 s o más en creación de comprobantes: en picos, algunas tardan. */
export const TIMEOUT_EMISION_MS = 120_000;

export const OPERACION_EMISION = 'factura_emitir';

// La estrategia de lote vive con el lote (`facturacion.lote.repo.ts`) desde que la cola también lo
// crea. Se reexporta para que quien la importe desde aquí siga encontrándola.
export { ESTRATEGIA_LOTE } from './facturacion.lote.repo.js';

/**
 * Circuito propio de la emisión.
 *
 * Separado del de terceros y del de sondeo a propósito: la cuota es de la EMPRESA y se comparte —por
 * eso la clave del limitador sí es común—, pero la salud es del ENDPOINT. Que `/v1/customers` esté
 * caído no debe impedir intentar `/v1/invoices`.
 */
export function claveCortacircuitosEmision(ambiente: string): string {
  return `siigo:invoices:${ambiente}`;
}

/** Medio centavo. Por debajo de eso la diferencia es redondeo del motor, no un descuadre. */
const TOLERANCIA_TOTAL = 0.005;

export type DesenlaceEmision =
  /** Se emitió en esta llamada. */
  | 'emitida'
  /** La clave ya estaba emitida: se devuelve aquella y NO se llama a Siigo (AC2). */
  | 'ya_emitida'
  /** Otro proceso la tiene reservada y su arrendamiento sigue vivo (AC2, AC3). */
  | 'en_curso'
  /** La reserva estaba huérfana: se derivó a reconciliación en vez de emitir en paralelo (AC4). */
  | 'huerfana'
  /** El intento terminó en fallo. `errorCode` y `errorDetalle` dicen cuál. */
  | 'fallida'
  /** Las guardas la rechazaron antes de tocar la red (AC7). */
  | 'no_elegible';

export interface ResultadoEmision {
  desenlace: DesenlaceEmision;
  /** La fila de la factura, salvo cuando las guardas cortaron antes de reservarla. */
  facturaId: string | null;
  siigoInvoiceId: string | null;
  numero: string | null;
  cufe: string | null;
  publicUrl: string | null;
  totalSiigo: string | null;
  requiereRevision: boolean;
  revisionMotivo: string | null;
  errorCode: string | null;
  errorDetalle: string | null;
  /** Por qué no era elegible. Vacío salvo en `no_elegible`; se propaga tal cual (AC7). */
  motivos: string[];
}

/** Fallo de uso del servicio: datos que faltan para poder siquiera intentar. */
export class SiigoEmisionError extends Error {
  readonly codigo: 'sin_tramites' | 'sin_configuracion' | 'sin_mapeo' | 'datos';

  constructor(codigo: SiigoEmisionError['codigo'], message: string) {
    super(message);
    this.name = 'SiigoEmisionError';
    this.codigo = codigo;
  }
}

// ── Lo que hace falta para armar ────────────────────────────────────────────

/** La respuesta de Siigo, reducida a lo que FLITO guarda. */
export interface FacturaEmitida {
  siigoInvoiceId: string;
  numero: string | null;
  comprobanteNombre: string | null;
  cufe: string | null;
  publicUrl: string | null;
  /** `null` cuando Siigo no lo reportó — que NO es lo mismo que cero (ver `revisionDeTotal`). */
  total: number | null;
}

/**
 * Normaliza la respuesta de creación de factura.
 *
 * Lista blanca: se lee lo que se va a guardar y nada más. La respuesta de Siigo trae el documento
 * entero —items, pagos, cliente— y volcarlo en la bitácora o en columnas nuevas metería datos del
 * titular en sitios que no los necesitan.
 *
 * `id` es obligatorio y por eso lanza si falta: sin identificador no hay nada que reconciliar
 * después, y un CHECK de la tabla impide siquiera guardar una emitida sin él.
 */
export function normalizarFacturaEmitida(datos: unknown): FacturaEmitida {
  if (typeof datos !== 'object' || datos === null) {
    throw new SiigoEmisionError('datos', 'Siigo respondió a la creación de la factura con un cuerpo ilegible.');
  }
  const d = datos as Record<string, unknown>;
  const id = typeof d.id === 'string' ? d.id.trim() : '';
  if (!id) {
    throw new SiigoEmisionError(
      'datos', 'Siigo respondió a la creación de la factura sin identificador de documento.',
    );
  }

  const total = typeof d.total === 'number' && Number.isFinite(d.total) ? d.total : null;
  return {
    siigoInvoiceId: id,
    numero: d.number === null || d.number === undefined ? null : String(d.number),
    comprobanteNombre: typeof d.name === 'string' ? d.name : null,
    // El CUFE solo existe cuando la DIAN ya se pronunció. En la creación casi siempre viene vacío:
    // ausente NO es un error, es el estado normal de un documento recién enviado a validación.
    cufe: typeof d.cufe === 'string' && d.cufe ? d.cufe : null,
    publicUrl: typeof d.public_url === 'string' ? d.public_url : null,
    total,
  };
}

/**
 * Lo que de la petición se puede escribir en una tabla que prohíbe rectificar y suprimir (AC8).
 *
 * `siigo_operaciones` es WORM: sus disparadores rechazan UPDATE y DELETE. Lo que se escriba ahí ya
 * no se puede corregir ni borrar, así que los derechos de rectificación y supresión de la Ley 1581
 * (art. 8, lit. d y e) no se pueden ejercer sobre su contenido. Eso obliga a elegir qué entra.
 *
 * **Quedan fuera dos cosas y las dos son datos personales:**
 *
 *   · `customer.identification` — es el NIT de una empresa casi siempre, pero el modelo admite
 *     `personType: 'Person'`, y entonces es una **cédula**. En su lugar se guarda el id del cliente
 *     en FLITO, que identifica al adquiriente igual de bien para reconstruir qué pasó y sí se puede
 *     seguir hasta una fila que sí se puede rectificar.
 *   · la **placa** de las observaciones. Es dato personal en cuanto es asociable a su propietario, y
 *     esa asociación es justo lo que FLITO guarda. Se conserva el identificador FLIT, que es lo que
 *     hace falta para saber de qué trámite era la factura — y lo que usa la reconciliación.
 *
 * Lo demás —comprobante, fecha, vendedor, líneas con su código e importe, forma de pago— es
 * contabilidad, no dato del titular, y es exactamente lo que hay que poder mirar cuando alguien
 * pregunte por qué esta factura salió como salió.
 */
export function peticionParaBitacora(
  cuerpo: Record<string, unknown>, clienteId: number, idsFlit: string[],
): Record<string, unknown> {
  return {
    document: cuerpo.document,
    date: cuerpo.date,
    seller: cuerpo.seller,
    cost_center: cuerpo.cost_center,
    currency: cuerpo.currency,
    items: cuerpo.items,
    payments: cuerpo.payments,
    stamp: cuerpo.stamp,
    mail: cuerpo.mail,
    /** El adquiriente, por su id en FLITO. Ni identificación ni nombre. */
    clienteId,
    /** Sucursal sí: es un número de configuración de Siigo, no un dato de nadie. */
    branch_office: (cuerpo.customer as { branch_office?: unknown } | undefined)?.branch_office ?? null,
    /** Los identificadores de trámite, sin la placa ni el tipo. */
    tramites: idsFlit,
  };
}

/**
 * AC6 — ¿hay que marcarla para revisión?
 *
 * Devuelve el motivo, o `null` si el total cuadra. **Que Siigo no reporte total también es motivo**:
 * no poder comprobarlo no es lo mismo que haberlo comprobado. Tratar el hueco como «cuadra» es
 * exactamente la forma de que un descuadre pase en silencio.
 *
 * La factura queda `emitida` en los dos casos. La marca es APARTE del estado porque el documento
 * existe ante la DIAN pase lo que pase: convertirlo en un estado habría perdido esa mitad.
 */
export function revisionDeTotal(totalSiigo: number | null, totalEsperado: number): string | null {
  if (totalSiigo === null) {
    return `Siigo no reportó el total de la factura. El esperado según la liquidación es ${totalEsperado.toFixed(2)}.`;
  }
  const diferencia = totalSiigo - totalEsperado;
  if (Math.abs(diferencia) <= TOLERANCIA_TOTAL) return null;
  return `El total devuelto por Siigo (${totalSiigo.toFixed(2)}) no coincide con el de la liquidación `
    + `(${totalEsperado.toFixed(2)}). Diferencia: ${diferencia.toFixed(2)}.`;
}

export interface FilaTramiteEmision {
  tramiteId: string;
  idFlit: string;
  placa: string | null;
  tipoTramite: string | null;
  companiaId: number | null;
  liquidacionId: string | null;
  valores: TramiteFacturable['liquidacion'];
}

/** Los datos de los trámites que van en la factura. Una consulta, sin los joins del reporte. */
export async function cargarTramites(tramiteIds: string[]): Promise<FilaTramiteEmision[]> {
  const filas = await db.select({
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    placa: vehicles.plate,
    tipoTramite: flitoTramites.tipoTramite,
    companiaId: flitoTramites.companiaId,
    liquidacionId: flitoLiquidaciones.id,
    valorSoat: flitoLiquidaciones.valorSoat,
    valorImpuesto: flitoLiquidaciones.valorImpuesto,
    valorDerecho: flitoLiquidaciones.valorDerecho,
    valorTramiteDigital: flitoLiquidaciones.valorTramiteDigital,
    valorLogistica: flitoLiquidaciones.valorLogistica,
    valorGmf: flitoLiquidaciones.valorGmf,
  })
    .from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(flitoLiquidaciones, eq(flitoLiquidaciones.tramiteId, flitoTramites.id))
    .where(sql`${flitoTramites.id} = ANY(${sql.param(tramiteIds)}::uuid[])`);

  return filas.map((f) => ({
    tramiteId: String(f.tramiteId),
    idFlit: f.idFlit,
    placa: f.placa ?? null,
    tipoTramite: f.tipoTramite ?? null,
    companiaId: f.companiaId ?? null,
    liquidacionId: f.liquidacionId === null || f.liquidacionId === undefined ? null : String(f.liquidacionId),
    valores: {
      valorSoat: f.valorSoat ?? null,
      valorImpuesto: f.valorImpuesto ?? null,
      valorDerecho: f.valorDerecho ?? null,
      valorTramiteDigital: f.valorTramiteDigital ?? null,
      valorLogistica: f.valorLogistica ?? null,
      valorGmf: f.valorGmf ?? null,
    },
  }));
}

/** El mapeo de cada concepto que aparece en el grupo, resuelto una vez por pareja. */
async function cargarMapeo(
  ambiente: SiigoAmbiente, tramites: FilaTramiteEmision[],
): Promise<MapeoPorConcepto> {
  const mapeo: MapeoPorConcepto = {};
  const resueltos = new Set<string>();

  for (const t of tramites) {
    for (const concepto of conceptosAplicables(t.valores)) {
      // Por concepto Y tipo de trámite: la resolución admite una fila específica del tipo que gana a
      // la genérica, así que memorizar solo por concepto devolvería la del primer tipo que pasara.
      const clave = `${concepto}|${t.tipoTramite ?? ''}`;
      if (resueltos.has(clave)) continue;
      resueltos.add(clave);

      const r = await resolverMapeo(ambiente, concepto, t.tipoTramite);
      if (r) mapeo[concepto] = r.mapeo;
    }
  }
  return mapeo;
}

/** Fecha del documento en hora de Colombia. Siigo rechaza fechas anteriores a hoy en electrónicas. */
export function fechaDocumento(ahora: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_COLOMBIA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ahora);
}

export interface PreparacionEmision {
  armada: FacturaArmada;
  /** El cuerpo tal como viaja a Siigo: sin `_total`, que es trazabilidad interna. */
  cuerpo: Record<string, unknown>;
  tramites: FilaTramiteEmision[];
  huella: string;
  clave: string;
  /** Los identificadores FLIT del grupo. Es lo único de las observaciones que va a la bitácora. */
  idsFlit: string[];
}

export interface EntradaPreparacion {
  /** La identidad del LOTE. Sale de lo que se pidió facturar, no de lo que la consulta encontró. */
  tramiteIds: string[];
  tramites: FilaTramiteEmision[];
  ambiente: SiigoAmbiente;
  tercero: TerceroResuelto;
  ahora: Date;
}

/**
 * Arma la factura de un conjunto de trámites, con el tercero y las filas ya resueltos.
 *
 * Recibe el tercero en vez de resolverlo para que la reconciliación pueda reconstruir **el mismo
 * total esperado** sin escribir nada en Siigo: ella lee el vínculo local, la emisión lo asegura
 * contra Siigo, y las dos pasan por aquí. Una sola definición de «cuánto debía costar».
 *
 * Y recibe las filas ya cargadas porque quien llama necesita mirarlas antes —para saber a qué
 * compañía se factura— y cargarlas dos veces abriría la puerta a que las dos lecturas devolvieran
 * cosas distintas si la liquidación cambiara entre una y otra.
 */
export async function prepararEmision(entrada: EntradaPreparacion): Promise<PreparacionEmision> {
  const { tramiteIds, tramites, ambiente, tercero, ahora } = entrada;
  if (tramites.length === 0) {
    throw new SiigoEmisionError('sin_tramites', 'No se encontró ninguno de los trámites indicados.');
  }
  // No basta con que haya alguno. La clave de idempotencia se deriva de `tramiteIds` —la identidad
  // del lote— mientras que el cuerpo y las filas puente salen de `tramites`. Si divergen, la clave
  // del conjunto {A, B} la consumiría una factura que solo contiene A, y B quedaría ni facturado ni
  // marcado: no habría error, solo un trámite que desaparece del circuito.
  if (tramites.length !== new Set(tramiteIds).size) {
    throw new SiigoEmisionError(
      'sin_tramites',
      `Se pidieron ${new Set(tramiteIds).size} trámites y solo se pudieron cargar ${tramites.length}. `
      + 'No se factura un lote incompleto.',
    );
  }

  const config = await parametrosDeEmision(ambiente);
  if (!config || !config.documentoTipoCodigo || !config.vendedorCodigo || !config.formaPagoCodigo) {
    throw new SiigoEmisionError(
      'sin_configuracion',
      'La configuración de emisión del ambiente está incompleta: falta el tipo de comprobante, el vendedor o la forma de pago.',
    );
  }

  const mapeo = await cargarMapeo(ambiente, tramites);

  const armada = armarFactura({
    tramites: tramites.map((t) => ({
      tramiteId: t.tramiteId,
      idFlit: t.idFlit,
      placa: t.placa,
      tipoTramite: t.tipoTramite,
      liquidacion: t.valores,
    })),
    tercero,
    parametros: {
      documentoTipoCodigo: config.documentoTipoCodigo,
      vendedorCodigo: config.vendedorCodigo,
      formaPagoCodigo: config.formaPagoCodigo,
      centroCostoCodigo: config.centroCostoCodigo,
      plazoVencimientoDias: config.plazoVencimientoDias,
      moneda: config.moneda,
      retencionesEstrategia: config.retencionesEstrategia,
      estrategiaNumeracion: config.estrategiaNumeracion,
    },
    mapeo,
    fecha: fechaDocumento(ahora),
  });

  // `_total` NO viaja a Siigo: el armador lo marca como trazabilidad interna. Enviarlo sería un
  // campo desconocido en un documento fiscal, y Siigo rechaza lo que su comprobante no tiene
  // configurado. Se quita aquí, en el único sitio que llama a la red.
  const { _total: _descartado, ...cuerpo } = armada;

  const huella = huellaDeTramites(tramiteIds);
  return {
    armada,
    cuerpo: cuerpo as unknown as Record<string, unknown>,
    tramites,
    huella,
    clave: claveIdempotencia(ambiente, huella),
    idsFlit: tramites.map((t) => t.idFlit),
  };
}

// ── La reserva ──────────────────────────────────────────────────────────────

/** Lo que se sabe de la fila reservada. Se lee entero porque el conflicto se resuelve por estado. */
export interface FilaFacturaReservada {
  id: string;
  estado: string;
  intentos: number;
  enProcesoDesde: Date | null;
  siigoInvoiceId: string | null;
  numero: string | null;
  cufe: string | null;
  publicUrl: string | null;
  totalSiigo: string | null;
  requiereRevision: boolean;
  revisionMotivo: string | null;
  errorCode: string | null;
  errorDetalle: string | null;
}

const COLUMNAS_FACTURA = {
  id: siigoFacturas.id,
  estado: siigoFacturas.estado,
  intentos: siigoFacturas.intentos,
  enProcesoDesde: siigoFacturas.enProcesoDesde,
  siigoInvoiceId: siigoFacturas.siigoInvoiceId,
  numero: siigoFacturas.numero,
  cufe: siigoFacturas.cufe,
  publicUrl: siigoFacturas.publicUrl,
  totalSiigo: siigoFacturas.totalSiigo,
  requiereRevision: siigoFacturas.requiereRevision,
  revisionMotivo: siigoFacturas.revisionMotivo,
  errorCode: siigoFacturas.errorCode,
  errorDetalle: siigoFacturas.errorDetalle,
};

function aFila(f: Record<string, unknown>): FilaFacturaReservada {
  return {
    id: String(f.id),
    estado: String(f.estado),
    intentos: Number(f.intentos) || 0,
    enProcesoDesde: f.enProcesoDesde instanceof Date ? f.enProcesoDesde
      : f.enProcesoDesde ? new Date(String(f.enProcesoDesde)) : null,
    siigoInvoiceId: (f.siigoInvoiceId as string | null) ?? null,
    numero: (f.numero as string | null) ?? null,
    cufe: (f.cufe as string | null) ?? null,
    publicUrl: (f.publicUrl as string | null) ?? null,
    totalSiigo: (f.totalSiigo as string | null) ?? null,
    requiereRevision: f.requiereRevision === true,
    revisionMotivo: (f.revisionMotivo as string | null) ?? null,
    errorCode: (f.errorCode as string | null) ?? null,
    errorDetalle: (f.errorDetalle as string | null) ?? null,
  };
}

/** La fila de una clave, si existe. */
export async function facturaDeClave(
  ambiente: SiigoAmbiente, clave: string,
): Promise<FilaFacturaReservada | null> {
  const [f] = await db.select(COLUMNAS_FACTURA).from(siigoFacturas)
    .where(and(eq(siigoFacturas.ambiente, ambiente), eq(siigoFacturas.idempotencyKey, clave)))
    .limit(1);
  return f ? aFila(f as Record<string, unknown>) : null;
}

/**
 * AC1 — Reserva la clave ANTES de llamar a Siigo. Devuelve `null` si ya estaba reservada.
 *
 * `ON CONFLICT DO NOTHING` y no una consulta previa: entre un SELECT y un INSERT cabe otra petición,
 * y el resultado de esa carrera son dos facturas ante la DIAN. Que la reserva «no falle cuando la
 * clave ya existe» es literal — no lanza, devuelve nada, y quien llama resuelve el conflicto.
 *
 * Las filas puente van en la MISMA transacción: una factura reservada sin sus trámites no ocuparía
 * el índice parcial que impide que un trámite esté en dos facturas vivas, y esa es la tercera
 * cerradura del modelo.
 */
export async function reservarClave(entrada: {
  loteId: string;
  ambiente: SiigoAmbiente;
  clave: string;
  tramites: FilaTramiteEmision[];
  ahora: Date;
}): Promise<FilaFacturaReservada | null> {
  return db.transaction(async (tx) => {
    const [creada] = await tx.insert(siigoFacturas)
      .values({
        loteId: entrada.loteId,
        ambiente: entrada.ambiente,
        idempotencyKey: entrada.clave,
        estado: 'en_proceso',
        enProcesoDesde: entrada.ahora,
        intentos: 1,
      })
      .onConflictDoNothing({ target: [siigoFacturas.ambiente, siigoFacturas.idempotencyKey] })
      .returning(COLUMNAS_FACTURA);

    if (!creada) return null;

    const fila = aFila(creada as Record<string, unknown>);
    try {
      await tx.insert(siigoFacturaTramites).values(entrada.tramites.map((t) => ({
        facturaId: fila.id,
        tramiteId: t.tramiteId,
        liquidacionId: t.liquidacionId,
      })));
    } catch (e) {
      // El índice parcial `idx_siigo_factura_tramites_vivo` acaba de impedir que un trámite esté en
      // dos facturas vivas. Es una carrera legítima: otro proceso lo facturó entre la elegibilidad y
      // esta transacción, y la base hizo justo su trabajo. Se traduce a un error de dominio porque
      // el de Postgres, envuelto por drizzle, llega con la sentencia y sus parámetros dentro y esto
      // acaba en un log. La transacción entera revierte, así que no queda ninguna clave reservada.
      if (esViolacionDeUnico(e)) {
        throw new SiigoEmisionError(
          'datos',
          'Otro proceso acaba de facturar alguno de estos trámites. No se emitió nada.',
        );
      }
      throw e;
    }
    return fila;
  });
}

/**
 * AC3 — Reclama una fila `fallida` para reintentarla. Devuelve `null` si otro se la llevó.
 *
 * **Esta es la corrección que no se puede suavizar.** La condición `estado='fallida'` viaja DENTRO
 * del `UPDATE`, así que PostgreSQL serializa los dos reintentos y solo uno ve fila; el otro recibe
 * cero y termina sin llamar a Siigo. Leer el estado y luego actualizar, aunque sea una línea más
 * abajo, deja hueco para que los dos lean `fallida` y los dos emitan.
 *
 * El contador sube exactamente una vez porque sube en el MISMO UPDATE que gana la carrera. Y el
 * error anterior se borra: describía el intento pasado, y dejarlo haría creer que el nuevo también
 * falló por eso.
 */
export async function reclamarFallida(entrada: {
  ambiente: SiigoAmbiente;
  clave: string;
  ahora: Date;
}): Promise<FilaFacturaReservada | null> {
  try {
    return await reclamar(entrada);
  } catch (e) {
    // La transición `fallida → en_proceso` dispara el sincronizador de la fila puente, que vuelve a
    // marcarla viva — y eso puede chocar con el índice que impide que un trámite esté en dos
    // facturas vivas, si otra clave se lo llevó mientras tanto. La reserva ya traduce ese caso; aquí
    // faltaba, y salía un error crudo del motor con la sentencia y sus parámetros dentro.
    if (esViolacionDeUnico(e)) {
      throw new SiigoEmisionError(
        'datos',
        'Otro proceso se llevó alguno de estos trámites mientras se reintentaba. No se emitió nada.',
      );
    }
    throw e;
  }
}

async function reclamar(entrada: {
  ambiente: SiigoAmbiente;
  clave: string;
  ahora: Date;
}): Promise<FilaFacturaReservada | null> {
  const [fila] = await db.update(siigoFacturas)
    .set({
      estado: 'en_proceso',
      enProcesoDesde: entrada.ahora,
      intentos: sql`${siigoFacturas.intentos} + 1`,
      errorCode: null,
      errorDetalle: null,
      // La marca de revisión también se limpia, y por el mismo motivo que el error: describía el
      // intento anterior. Una fila que la reconciliación marcó como imposible de comprobar puede
      // acabar reclamada por un reintento legítimo, y heredar ese motivo caducado haría que la nueva
      // emisión naciera señalada por algo que ya no es cierto.
      requiereRevision: false,
      revisionMotivo: null,
      updatedAt: entrada.ahora,
    })
    .where(and(
      eq(siigoFacturas.ambiente, entrada.ambiente),
      eq(siigoFacturas.idempotencyKey, entrada.clave),
      eq(siigoFacturas.estado, 'fallida'),
    ))
    .returning(COLUMNAS_FACTURA);

  return fila ? aFila(fila as Record<string, unknown>) : null;
}

/**
 * AC4 — ¿Se le venció el arrendamiento a una fila en proceso?
 *
 * Sin reloj no se puede distinguir «va en camino» de «su proceso murió», y las dos respuestas
 * llevan a acciones opuestas: esperar o reconciliar. `enProcesoDesde` nulo se trata como vencida
 * porque un CHECK de la tabla impide que exista; si apareciera, sería una fila corrupta que hay
 * que examinar, no una emisión en curso a la que dejar en paz.
 */
export function arrendamientoVencido(
  fila: Pick<FilaFacturaReservada, 'estado' | 'enProcesoDesde'>, minutos: number, ahora: Date,
): boolean {
  if (fila.estado !== 'en_proceso') return false;
  if (!fila.enProcesoDesde) return true;
  return ahora.getTime() - fila.enProcesoDesde.getTime() > minutos * 60_000;
}

// ── El resultado ────────────────────────────────────────────────────────────

function resultadoDeFila(desenlace: DesenlaceEmision, f: FilaFacturaReservada): ResultadoEmision {
  return {
    desenlace,
    facturaId: f.id,
    siigoInvoiceId: f.siigoInvoiceId,
    numero: f.numero,
    cufe: f.cufe,
    publicUrl: f.publicUrl,
    totalSiigo: f.totalSiigo,
    requiereRevision: f.requiereRevision,
    revisionMotivo: f.revisionMotivo,
    errorCode: f.errorCode,
    errorDetalle: f.errorDetalle,
    motivos: [],
  };
}

/** Guarda el éxito. Si esto falla, la fila se queda `en_proceso` y la rescata la reconciliación. */
async function marcarEmitida(
  facturaId: string, emitida: FacturaEmitida, revision: string | null, ahora: Date,
  arrendamiento: Date | null,
): Promise<FilaFacturaReservada | null> {
  const [fila] = await db.update(siigoFacturas)
    .set({
      estado: 'emitida',
      siigoInvoiceId: emitida.siigoInvoiceId,
      numero: emitida.numero,
      comprobanteNombre: emitida.comprobanteNombre,
      cufe: emitida.cufe,
      publicUrl: emitida.publicUrl,
      totalSiigo: emitida.total === null ? null : emitida.total.toFixed(2),
      enviadaEn: ahora,
      enProcesoDesde: null,
      errorCode: null,
      errorDetalle: null,
      requiereRevision: revision !== null,
      revisionMotivo: revision,
      updatedAt: ahora,
    })
    // La condición de estado NO es decorativa. El arrendamiento no se renueva mientras dura el POST,
    // y `ejecutarConResiliencia` puede tardar mucho más que él: cuatro intentos de hasta 120 s, más
    // el retroceso, más lo que duerma el limitador esperando cupo de la ventana. Un emisor que
    // sobreviva a su arrendamiento se encuentra la fila YA reconciliada por el barrido, y sin esta
    // condición la pisaría. La reconciliación se protege así desde el principio; esto era la mitad
    // que faltaba de la misma regla.
    .where(and(
      eq(siigoFacturas.id, facturaId),
      eq(siigoFacturas.estado, 'en_proceso'),
      // Y del arrendamiento PROPIO, no de cualquiera. `estado='en_proceso'` no dice de QUIÉN es la
      // reserva: entre medias la fila pudo pasar a `fallida` y ser reclamada por otro emisor, que la
      // devolvió a `en_proceso` con su marca. Un emisor zombi cumpliría la condición sobre la fila
      // de ese otro y la pisaría con el desenlace de una emisión anterior — liberando el trámite con
      // una petición todavía en vuelo. `en_proceso_desde` es el sello de quién la tiene ahora.
      arrendamiento === null
        ? isNull(siigoFacturas.enProcesoDesde)
        : eq(siigoFacturas.enProcesoDesde, arrendamiento),
    ))
    .returning(COLUMNAS_FACTURA);

  return fila ? aFila(fila as Record<string, unknown>) : null;
}

/** Guarda el fallo. `fallida` libera los trámites por disparador: el reintento legítimo puede volver. */
async function marcarFallida(
  facturaId: string, codigo: string, detalle: string, ahora: Date,
  arrendamiento: Date | null,
): Promise<FilaFacturaReservada | null> {
  const [fila] = await db.update(siigoFacturas)
    .set({
      estado: 'fallida',
      enProcesoDesde: null,
      errorCode: codigo.slice(0, 80),
      // `sanearMensaje` y no el mensaje crudo: un error del motor envuelto por drizzle llega con la
      // sentencia y sus parámetros dentro, y esta columna acaba en pantalla.
      errorDetalle: sanearMensaje(detalle),
      updatedAt: ahora,
    })
    // Misma condición y por la misma razón, agravada: devolver a `fallida` una fila que el barrido
    // ya dejó `emitida` liberaría su trámite —lo hace el disparador— con el documento vivo ante la
    // DIAN, y el trámite volvería a parecer no facturado.
    .where(and(
      eq(siigoFacturas.id, facturaId),
      eq(siigoFacturas.estado, 'en_proceso'),
      // Y del arrendamiento PROPIO, no de cualquiera. `estado='en_proceso'` no dice de QUIÉN es la
      // reserva: entre medias la fila pudo pasar a `fallida` y ser reclamada por otro emisor, que la
      // devolvió a `en_proceso` con su marca. Un emisor zombi cumpliría la condición sobre la fila
      // de ese otro y la pisaría con el desenlace de una emisión anterior — liberando el trámite con
      // una petición todavía en vuelo. `en_proceso_desde` es el sello de quién la tiene ahora.
      arrendamiento === null
        ? isNull(siigoFacturas.enProcesoDesde)
        : eq(siigoFacturas.enProcesoDesde, arrendamiento),
    ))
    .returning(COLUMNAS_FACTURA);

  return fila ? aFila(fila as Record<string, unknown>) : null;
}

/**
 * Código y detalle de un fallo, y —lo que decide qué se escribe— si Siigo llegó a CONTESTAR.
 *
 * `respondio: true` significa que Siigo evaluó la petición y la rechazó: el documento no existe, y
 * dejar la fila `fallida` es la verdad. `respondio: false` significa que no sabemos si el `POST`
 * llegó —un timeout, un socket cerrado, cuatro intentos agotados—, y ahí `fallida` sería una
 * afirmación que nadie ha comprobado.
 *
 * Es la misma distinción que la reconciliación defiende en el sentido contrario: ella se niega a
 * convertir «no pude comprobarlo» en «no existe». La emisión hacía esa conversión, en el otro
 * sentido, sobre exactamente la misma incertidumbre.
 */
function describirFallo(
  e: unknown,
): { codigo: string; detalle: string; definitivo: boolean; respondio: boolean } {
  if (e instanceof SiigoOperacionFallida) {
    const causa = e.causa;
    if (causa instanceof SiigoApiError) {
      return {
        codigo: causa.code,
        detalle: causa.descripcionOperativa,
        definitivo: e.definitivo,
        respondio: rechazoConcluyente(causa.status),
      };
    }
    return { codigo: 'siigo_no_responde', detalle: e.message, definitivo: e.definitivo, respondio: false };
  }
  if (e instanceof SiigoApiError) {
    return {
      codigo: e.code,
      detalle: e.descripcionOperativa,
      definitivo: !e.reintentable,
      respondio: rechazoConcluyente(e.status),
    };
  }
  // Un fallo nuestro —armado, base de datos, lo que sea— tampoco dice nada sobre si el POST llegó.
  return { codigo: 'error_interno', detalle: detalleTecnico(e), definitivo: false, respondio: false };
}

/**
 * ¿Este fallo PRUEBA que no se creó el documento?
 *
 * Se decide por el estado HTTP, no por la clase del error, y ese matiz es la diferencia entre una
 * factura y dos. `traducirErrorSiigo` fabrica un `SiigoApiError` para **cualquier** respuesta que no
 * sea ok, incluidos 500, 502, 503, 504 y 408 — así que «es un `SiigoApiError`» no significa «Siigo
 * evaluó la petición y la rechazó».
 *
 * Solo un rechazo de negocio lo prueba: Siigo miró el documento, no le gustó y no lo creó. Un 500 es
 * lo contrario de una prueba — cabe perfectamente que la factura se creara y reventara al construir
 * la respuesta. Y un 504 dice literalmente que el backend no contestó a tiempo, o sea que pudo
 * procesarlo entero.
 *
 * Peor aún, el 500 no está en `STATUS_REINTENTABLES`, así que llega aquí como definitivo desde el
 * primer intento: sin esta distinción, un 500 marcaba la fila `fallida`, el disparador liberaba el
 * trámite y el siguiente reintento emitía sobre una factura que quizá ya existía.
 */
function rechazoConcluyente(status: number): boolean {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

// ── La emisión ──────────────────────────────────────────────────────────────

export interface OpcionesEmision {
  ambiente: SiigoAmbiente;
  usuarioId?: number | null;
  /** Inyectable: probar el arrendamiento sin esperar quince minutos reales. */
  ahora?: () => Date;
  /** Minutos de arrendamiento. Por defecto, el configurado del ambiente. */
  arrendamientoMin?: number;
}

/**
 * Emite la factura de un conjunto de trámites.
 *
 * Un conjunto y no un trámite porque el modelo es N:1 desde el primer día; hoy el agrupador siempre
 * entrega grupos de uno. Quien orquesta la cola (HU #11327) llama a esto una vez por grupo.
 */
export async function emitirFactura(
  tramiteIds: string[], opciones: OpcionesEmision,
): Promise<ResultadoEmision> {
  const ambiente = opciones.ambiente;
  const usuarioId = opciones.usuarioId ?? null;
  const relojDe = opciones.ahora ?? (() => new Date());
  const ids = [...new Set(tramiteIds)].sort();

  if (ids.length === 0) {
    throw new SiigoEmisionError('sin_tramites', 'No se indicó ningún trámite que facturar.');
  }

  const huella = huellaDeTramites(ids);
  const clave = claveIdempotencia(ambiente, huella);

  // ── AC7 — las guardas, ANTES de cualquier petición ────────────────────────
  //
  // Se llama al embudo de la HU #11324, que a su vez llama a la compuerta de la #11285 y al
  // validador de la #11296. Ninguna comprobación nueva: una segunda versión de estas reglas sería
  // la que se quedara vieja, y aquí quedarse vieja significa emitir lo que no se debía.
  // Se miran TODOS los veredictos, no el del primer trámite. Hoy el agrupador entrega grupos de uno
  // y daría igual; el día que se consolide, quedarse con el primero significaría facturar un grupo
  // en el que el segundo trámite no tiene el cliente en regla — y el fallo no se vería, porque la
  // factura saldría bien. Un veredicto que falte cuenta como no elegible: un trámite del que la
  // elegibilidad no dice nada no es un trámite aprobado.
  const veredictos = await evaluarElegibilidad(ids, ambiente);
  const porTramite = new Map(veredictos.map((v) => [v.tramiteId, v]));
  const bloqueos: MotivoElegibilidad[] = [];
  for (const id of ids) {
    const v = porTramite.get(id);
    if (!v) {
      bloqueos.push({
        motivo: 'sin_compania',
        detalle: `El trámite ${id} no existe o no se pudo evaluar, así que no se puede facturar.`,
      });
      continue;
    }
    if (!v.elegible) bloqueos.push(...v.motivos);
  }

  if (bloqueos.length > 0) {
    const rechazo = (): ResultadoEmision => ({
      desenlace: 'no_elegible',
      facturaId: null,
      siigoInvoiceId: null, numero: null, cufe: null, publicUrl: null, totalSiigo: null,
      requiereRevision: false, revisionMotivo: null, errorCode: null, errorDetalle: null,
      motivos: bloqueos.map((m) => m.detalle),
    });

    if (bloqueos.some((m) => m.motivo !== 'ya_facturado')) return rechazo();

    // «Ya facturado» no es un error de configuración: es la respuesta idempotente. Si la factura
    // viva es la de ESTA clave, se devuelve aquella (AC2) en vez de un rechazo que haría pensar que
    // hay algo que corregir. Si es de otra clave —posible el día que se consolide—, sí es un
    // rechazo: emitir sería duplicar el trámite en dos facturas distintas.
    const viva = await facturaDeClave(ambiente, clave);
    if (!viva) return rechazo();
    if (viva.estado === 'emitida') return resultadoDeFila('ya_emitida', viva);

    // La fila de ESTA clave está `fallida` y aun así el trámite figura ocupado: lo retiene una
    // factura viva de OTRA clave. Eso no es «en curso» —nadie la está emitiendo y no se va a
    // resolver sola—, y decirlo así haría que un orquestador que reencola ante `en_curso` girara
    // en vacío indefinidamente. Es un rechazo, y el motivo ya lo explica la elegibilidad.
    if (viva.estado !== 'en_proceso') return rechazo();

    const minutos = opciones.arrendamientoMin ?? await arrendamientoConfigurado(ambiente);
    if (arrendamientoVencido(viva, minutos, relojDe())) return resultadoDeFila('huerfana', viva);
    return resultadoDeFila('en_curso', viva);
  }

  // ── Tercero y armado, todavía sin reservar ────────────────────────────────
  const tramites = await cargarTramites(ids);
  const tercero = await asegurarTercero(companiaDelGrupo(tramites));

  const ahora = relojDe();
  const preparacion = await prepararEmision({
    tramiteIds: ids,
    tramites,
    ambiente,
    tercero: { identificacion: tercero.identificacion, sucursal: tercero.sucursal },
    ahora,
  });

  // ── AC1 — la reserva, y solo entonces la red ──────────────────────────────
  const loteId = await asegurarLote({
    ambiente, huella: preparacion.huella, tramiteIds: ids, creadoPor: usuarioId,
  });
  if (!loteId) {
    // Solo puede pasar si alguien borró el lote entre el INSERT y el SELECT. No se inventa uno:
    // seguir con un lote desconocido acabaría en una clave de idempotencia sin dueño.
    throw new SiigoEmisionError('datos', 'El lote de facturación desapareció mientras se creaba.');
  }
  let fila = await reservarClave({
    loteId, ambiente, clave: preparacion.clave, tramites: preparacion.tramites, ahora,
  });

  if (!fila) {
    // AC2 — la clave ya estaba tomada. El estado decide, y cada estado tiene UNA salida.
    const existente = await facturaDeClave(ambiente, preparacion.clave);
    if (!existente) {
      throw new SiigoEmisionError('datos', 'La clave de idempotencia está ocupada por una fila que no se puede leer.');
    }
    if (existente.estado === 'emitida') return resultadoDeFila('ya_emitida', existente);

    if (existente.estado === 'fallida') {
      // AC3 — reclamar, no leer y decidir. Quien no recibe fila no emite.
      const reclamada = await reclamarFallida({ ambiente, clave: preparacion.clave, ahora });
      if (!reclamada) {
        const tras = await facturaDeClave(ambiente, preparacion.clave);
        return resultadoDeFila('en_curso', tras ?? existente);
      }
      fila = reclamada;
    } else {
      const minutos = opciones.arrendamientoMin ?? await arrendamientoConfigurado(ambiente);
      if (arrendamientoVencido(existente, minutos, ahora)) return resultadoDeFila('huerfana', existente);
      return resultadoDeFila('en_curso', existente);
    }
  }

  return emitirReservada(fila, preparacion, {
    ambiente, usuarioId, ahora, clienteId: tercero.clienteId,
  });
}

/**
 * El POST y el registro de su resultado. La fila YA está reservada al entrar aquí.
 *
 * Se expone porque la reconciliación necesita exactamente esto cuando decide que la factura no
 * llegó a existir: reintentar sin volver a reservar. Que la reserva sea del que llama es lo que
 * impide que esta función pueda emitir por su cuenta sin que nadie tuviera la clave.
 */
async function emitirReservada(
  fila: FilaFacturaReservada,
  preparacion: PreparacionEmision,
  ctx: { ambiente: SiigoAmbiente; usuarioId: number | null; ahora: Date; clienteId: number },
): Promise<ResultadoEmision> {
  const inicio = Date.now();
  const modo = modoSiigo();

  try {
    const datos = await ejecutarConResiliencia(
      () => siigoRequestOrThrow<unknown>({
        metodo: 'POST',
        ruta: '/v1/invoices',
        cuerpo: preparacion.cuerpo,
        idempotencyKey: preparacion.clave,
        ambiente: ctx.ambiente,
        timeoutMs: TIMEOUT_EMISION_MS,
      }),
      {
        // La cuota es de la EMPRESA y se comparte con el resto de flujos; el circuito es del endpoint.
        clave: `siigo:${ctx.ambiente}`,
        claveCortacircuitos: claveCortacircuitosEmision(ctx.ambiente),
        alReintentar: ({ intento, esperaMs }) => {
          log.warn({ facturaId: fila.id, intento, esperaMs }, 'reintentando la emisión');
        },
      },
    );

    const emitida = normalizarFacturaEmitida(datos);
    const revision = revisionDeTotal(emitida.total, preparacion.armada._total);
    const actualizada = await marcarEmitida(fila.id, emitida, revision, ctx.ahora, fila.enProcesoDesde);

    await registrarOperacion({
      operacion: OPERACION_EMISION,
      metodo: 'POST',
      ruta: '/v1/invoices',
      entidadTipo: 'siigo_factura',
      entidadId: fila.id,
      intento: fila.intentos,
      ambiente: ctx.ambiente,
      modo,
      requestBody: peticionParaBitacora(preparacion.cuerpo, ctx.clienteId, preparacion.idsFlit),
      // La respuesta se registra NORMALIZADA, no cruda: el cuerpo de Siigo trae el cliente entero
      // —identificación, correos, dirección— y esta tabla prohíbe UPDATE y DELETE por disparador.
      // Un dato personal escrito aquí por error ya no se puede rectificar ni suprimir.
      responseBody: emitida,
      statusHttp: 201,
      resultado: 'ok',
      duracionMs: Date.now() - inicio,
      createdBy: ctx.usuarioId,
    });

    if (!actualizada) {
      // El POST llegó y el UPDATE no encontró la fila. Es exactamente el caso del AC5: la factura
      // existe en Siigo y aquí no consta. No se inventa el desenlace — se deja que la reconciliación
      // la recupere por el identificador FLIT de las observaciones.
      log.error({ facturaId: fila.id, siigoInvoiceId: emitida.siigoInvoiceId },
        'la factura se emitió en Siigo pero no se pudo actualizar la fila local');
      return { ...resultadoDeFila('huerfana', fila), siigoInvoiceId: emitida.siigoInvoiceId };
    }
    return resultadoDeFila('emitida', actualizada);
  } catch (e) {
    const { codigo, detalle, definitivo, respondio } = describirFallo(e);

    // La bitácora ANTES del UPDATE, y no después. `registrarOperacion` no lanza nunca por diseño,
    // pero `marcarFallida` sí: si la base es justo lo que está fallando, escribir primero la fila
    // dejaría el intento sin rastro — y el AC8 dice «todo intento», también los que terminan mal.
    // Con este orden, el peor caso es una fila que se queda `en_proceso` y la rescata el barrido,
    // pero con su fallo ya escrito y explicado.
    await registrarOperacion({
      operacion: OPERACION_EMISION,
      metodo: 'POST',
      ruta: '/v1/invoices',
      entidadTipo: 'siigo_factura',
      entidadId: fila.id,
      intento: fila.intentos,
      ambiente: ctx.ambiente,
      modo,
      requestBody: peticionParaBitacora(preparacion.cuerpo, ctx.clienteId, preparacion.idsFlit),
      resultado: definitivo ? 'error_negocio' : 'error_tecnico',
      codigo,
      mensaje: detalle,
      duracionMs: Date.now() - inicio,
      createdBy: ctx.usuarioId,
    });

    // Solo se declara `fallida` cuando Siigo CONTESTÓ. Si no sabemos si el POST llegó, la fila se
    // queda `en_proceso` y la resuelve el barrido consultando —que es quien puede averiguarlo—. Al
    // revés, `fallida` liberaría el trámite por disparador y habilitaría un reintento sobre una
    // factura que quizá ya existe ante la DIAN.
    if (!respondio) {
      log.warn({ facturaId: fila.id, codigo },
        'la emisión no obtuvo respuesta de Siigo: la fila queda en proceso para que la reconcilie el barrido');
      return {
        ...resultadoDeFila('huerfana', fila),
        errorCode: codigo,
        errorDetalle: detalle,
      };
    }

    const actualizada = await marcarFallida(fila.id, codigo, detalle, ctx.ahora, fila.enProcesoDesde);
    return {
      ...resultadoDeFila('fallida', actualizada ?? fila),
      errorCode: codigo,
      errorDetalle: detalle,
    };
  }
}

// ── Datos auxiliares ────────────────────────────────────────────────────────

/**
 * La compañía del grupo. Todos sus trámites tienen que ser del mismo cliente.
 *
 * Facturar a dos clientes en un documento no es una factura rara: es una factura de la que no se
 * sabe quién es el adquiriente. La elegibilidad ya exige que cada trámite tenga compañía; lo que se
 * comprueba aquí es que sea LA MISMA.
 */
export function companiaDelGrupo(tramites: FilaTramiteEmision[]): number {
  const companias = [...new Set(tramites.map((t) => t.companiaId).filter((c): c is number => c !== null))];
  if (companias.length === 0) {
    throw new SiigoEmisionError('datos', 'Ninguno de los trámites tiene compañía asociada.');
  }
  if (companias.length > 1) {
    throw new SiigoEmisionError(
      'datos', 'Los trámites del grupo pertenecen a compañías distintas: no hay un único adquiriente.',
    );
  }
  return companias[0]!;
}

/**
 * Minutos de arrendamiento configurados del ambiente.
 *
 * El respaldo de quince es el mismo DEFAULT de la columna, no un número elegido aquí: sin
 * configuración guardada no hay nada que leer, y dejar la fila sin arrendamiento la volvería
 * inmortal — que es justo lo que el arrendamiento existe para impedir.
 */
export async function arrendamientoConfigurado(ambiente: SiigoAmbiente): Promise<number> {
  const config = await parametrosDeEmision(ambiente);
  return config?.arrendamientoEnProcesoMin ?? 15;
}

// `emitirReservada` NO se exporta a propósito. Emitir exige haber ganado la reserva, y esa
// secuencia —reservar y emitir— vive entera en `emitirFactura`. Un módulo que pudiera llamar al POST
// con una fila que no reclamó sería la puerta por la que se emite dos veces.
