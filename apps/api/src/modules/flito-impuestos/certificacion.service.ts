/**
 * Certificación de un impuesto contra el RUNT — orquestación (HU #11165).
 *
 * La DECISIÓN de si un impuesto es certificable es pura y vive en `certificacion-runt.ts`. Aquí va
 * todo lo que toca el mundo: leer el registro respetando la frontera del gestor, llamar al RUNT,
 * persistir y auditar. Separarlo permite probar las reglas sin red (el RUNT tiene 90 s de timeout y
 * captcha de pago en modo directo, así que no es invocable desde CI).
 *
 * Cinco desenlaces, no dos. `con_diferencias`, `traspaso_en_sincronizacion` y `error_servicio` son
 * cosas distintas y el gestor actúa distinto ante cada una: corregir el dato, esperar a mañana, o
 * reintentar en un rato. Colapsarlas en un «falló» genérico obligaría a adivinar cuál de las tres
 * era.
 */

import { and, eq } from 'drizzle-orm';
import {
  CONCURRENCIA_CERTIFICACION,
  ESTADOS_IMPUESTO_CERTIFICABLES,
  EstadoImpuesto,
  MotivoNoElegible,
  ResultadoCertificacion,
  TOPE_LOTE_CERTIFICACION,
  type ComparacionCampo,
  type DatosVehiculoFlito,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { auditLogs, flitoCompradores, flitoImpuestoCertificaciones, flitoImpuestos, flitoTramites, vehicles } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { conConcurrencia } from '../../shared/utils/con-concurrencia.js';
import { consultarVehiculoRunt } from '../runt/runt.service.js';
import { compararConRunt, esTraspasoEnSincronizacion, extraerVehiculoRunt, runtSinRegistro } from './certificacion-runt.js';
import { ImpuestoError, type ImpuestoCtx } from './flito-factura-venta.service.js';
import { buscarConAcceso } from './flito-impuestos.service.js';

const log = loggerFor('flito.impuestos.certificacion');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Se reexporta desde shared-types (HU #11168): la cola decide con esta lista qué filas muestran el
 * botón Certificar, así que tiene que ser LA MISMA que el backend usa para rechazar. Se conserva el
 * nombre exportado aquí para no tocar a quien ya la importaba de este módulo.
 */
export { ESTADOS_IMPUESTO_CERTIFICABLES };

export interface CertificacionVigente {
  id: string;
  impuestoId: string;
  placaConsultada: string;
  /** Documento del propietario con el que se consultó, o `null` si la consulta fue por VIN. */
  documentoConsultado: string | null;
  /** VIN con el que se consultó. Excluyente con `documentoConsultado`: siempre hay uno de los dos. */
  vinConsultado: string | null;
  tipoDocPropietario: string | null;
  /** Nombre del propietario según FLITO al certificar. `null` en certificaciones previas a 0122. */
  propietarioNombre: string | null;
  campos: ComparacionCampo[];
  certificadoPorNombre: string;
  createdAt: string;
}

export type ResultadoCertificar =
  | { resultado: typeof ResultadoCertificacion.CERTIFICADO; certificacion: CertificacionVigente }
  | { resultado: typeof ResultadoCertificacion.CON_DIFERENCIAS; campos: ComparacionCampo[]; diferenciasBloqueantes: ComparacionCampo[] }
  | { resultado: typeof ResultadoCertificacion.NO_ELEGIBLE; motivo: MotivoNoElegible; mensaje: string }
  | { resultado: typeof ResultadoCertificacion.TRASPASO_EN_SINCRONIZACION; mensaje: string }
  | { resultado: typeof ResultadoCertificacion.ERROR_SERVICIO; mensaje: string };

/** Datos del vehículo del trámite, que son los que se contrastan con el RUNT. */
interface DatosImpuesto extends DatosVehiculoFlito {
  ownerName: string | null;
  ownerDocument: string | null;
}

async function datosDelVehiculo(impuestoId: string): Promise<DatosImpuesto | null> {
  const [row] = await db.select({
    placa: vehicles.plate,
    vin: vehicles.vin,
    // `brand`/`model` en la tabla son marca y LÍNEA, no marca y año: el año vive en `year`. Mismo
    // mapeo que usa la cola (`flito-impuestos.service.ts:56`).
    marca: vehicles.brand,
    linea: vehicles.model,
    modelo: vehicles.year,
    clase: vehicles.vehicleClass,
    ownerName: vehicles.ownerName,
    ownerDocument: vehicles.ownerDocument,
    // El titular del TRÁMITE es el respaldo del titular del vehículo. Son el mismo dato por dos
    // caminos: FLIT lo manda como `cedulanit` y el sync lo guarda en ambos sitios, pero el vehículo
    // solo lo tiene desde que eso se corrigió. Leer los dos hace que la certificación funcione
    // también sobre lo sincronizado antes, sin esperar al backfill.
    compradorNombre: flitoCompradores.nombreCompleto,
    compradorDocumento: flitoCompradores.numeroDocumento,
  })
    .from(flitoImpuestos)
    .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(flitoCompradores, and(
      eq(flitoCompradores.tramiteId, flitoTramites.id),
      eq(flitoCompradores.orden, 0),
    ))
    .where(eq(flitoImpuestos.id, impuestoId))
    .limit(1);

  if (!row) return null;
  const { compradorNombre, compradorDocumento, ...vehiculo } = row;
  return {
    ...vehiculo,
    modelo: vehiculo.modelo === null ? null : String(vehiculo.modelo),
    ownerName: vehiculo.ownerName ?? compradorNombre ?? null,
    ownerDocument: vehiculo.ownerDocument ?? compradorDocumento ?? null,
  };
}

/**
 * Certifica un impuesto contra el RUNT.
 *
 * No lanza para los desenlaces esperables —discrepancia, traspaso sincronizando, RUNT caído—: los
 * devuelve. El masivo (HU #11166) necesita procesarlos por registro sin que uno malo aborte el lote,
 * y una excepción por cada resultado normal convertiría eso en un `try` por elemento. Solo lanza
 * `ImpuestoError` para lo que sí es excepcional: que el impuesto no exista o no sea accesible.
 */
export async function certificarImpuesto(id: string, ctx: ImpuestoCtx): Promise<ResultadoCertificar> {
  const imp = await buscarConAcceso(id, ctx);
  // 404 y no 403 a propósito: la frontera del gestor no debe revelar que el registro existe.
  if (!imp) throw new ImpuestoError(404, 'El impuesto no existe');

  if (!ESTADOS_IMPUESTO_CERTIFICABLES.includes(imp.estado as EstadoImpuesto)) {
    return {
      resultado: ResultadoCertificacion.NO_ELEGIBLE,
      motivo: MotivoNoElegible.ESTADO_NO_ELEGIBLE,
      mensaje: 'Solo se certifican impuestos en estado Solicitado.',
    };
  }

  const datos = await datosDelVehiculo(id);
  if (!datos) throw new ImpuestoError(404, 'El impuesto no existe');

  if (!datos.placa?.trim()) {
    return {
      resultado: ResultadoCertificacion.NO_ELEGIBLE,
      motivo: MotivoNoElegible.SIN_PLACA,
      mensaje: 'El vehículo no tiene placa registrada.',
    };
  }
  // El RUNT admite dos formas de identificar el vehículo: placa + documento del propietario, o VIN.
  // Se prefiere la primera porque ese par es además la prueba de propiedad en la que se apoya la
  // certificación (RN-02); el VIN es el respaldo cuando no hay documento, y sirve igual porque la
  // identidad del vehículo es placa/VIN (RN-01). Solo faltando los dos no hay consulta posible.
  const documento = datos.ownerDocument?.trim() || null;
  const vin = datos.vin?.trim() || null;
  if (!documento && !vin) {
    return {
      resultado: ResultadoCertificacion.NO_ELEGIBLE,
      motivo: MotivoNoElegible.SIN_DOCUMENTO_PROPIETARIO,
      mensaje: 'El vehículo no tiene documento de propietario ni VIN: no hay forma de consultar el RUNT.',
    };
  }

  const placa = datos.placa.trim();

  log.info(
    { impuestoId: id, via: documento ? 'documento' : 'vin', docPrefix: documento?.slice(0, 4) },
    'certificacion: consultando runt',
  );

  let runt: { ok?: boolean; data?: unknown; message?: string };
  try {
    // Con documento se consulta por placa; sin él, por VIN. No se mandan los dos: `runt-direct`
    // ignora el tipo de documento cuando hay VIN y probaría un único tipo, así que mezclarlos
    // desaprovecharía el barrido de tipos que sí hace la consulta por placa.
    runt = documento
      ? await consultarVehiculoRunt(placa, undefined, documento)
      : await consultarVehiculoRunt(placa, vin ?? undefined, undefined);
  } catch (e) {
    // `consultarVehiculoRunt` ya atrapa casi todo y devuelve `{ ok:false }`; esto cubre lo que se le
    // escape (p. ej. el rechazo del circuit breaker) para que un lote nunca muera por un registro.
    const mensaje = (e as Error)?.message || 'El servicio RUNT no está disponible.';
    log.warn({ impuestoId: id, err: mensaje }, 'certificacion: runt lanzó');
    return { resultado: ResultadoCertificacion.ERROR_SERVICIO, mensaje };
  }

  if (!runt?.ok || !runt?.data) {
    // Orden deliberado: el traspaso en sincronización se comprueba ANTES de dar por caído el
    // servicio. Es un rechazo legítimo del RUNT, no un fallo, y se resuelve solo en 24-72 h (RN-08).
    if (esTraspasoEnSincronizacion(runt?.message)) {
      return {
        resultado: ResultadoCertificacion.TRASPASO_EN_SINCRONIZACION,
        mensaje: 'El traspaso aún está sincronizando con el RUNT (24-72 horas hábiles). Reintenta más tarde.',
      };
    }
    return {
      resultado: ResultadoCertificacion.ERROR_SERVICIO,
      mensaje: runt?.message || 'El servicio RUNT no está disponible.',
    };
  }

  // Responder 200 no es lo mismo que haber encontrado el vehículo: el RUNT devuelve la ficha vacía
  // —con la placa consultada de vuelta— cuando no tiene nada registrado. Comparar contra eso
  // certificaría por el eco de la propia consulta.
  if (runtSinRegistro(runt.data)) {
    log.warn({ impuestoId: id, placa }, 'certificacion: runt respondió sin registro');
    return {
      resultado: ResultadoCertificacion.ERROR_SERVICIO,
      mensaje: 'El RUNT no tiene información registrada para este vehículo. Verifica la placa y el documento del propietario.',
    };
  }

  const veredicto = compararConRunt(datos, extraerVehiculoRunt(runt.data));

  if (!veredicto.certificable) {
    // Un intento con diferencias NO deja fila: el registro conserva la certificación anterior si la
    // tenía, y las métricas de certificación no se llenan de intentos fallidos.
    return {
      resultado: ResultadoCertificacion.CON_DIFERENCIAS,
      campos: veredicto.campos,
      diferenciasBloqueantes: veredicto.diferenciasBloqueantes,
    };
  }

  const tipoDocPropietario = (runt.data as { tipoDocPropietario?: unknown }).tipoDocPropietario;

  const fila = await db.transaction(async (tx: Tx) => {
    // Recertificar apaga la vigente antes de insertar. El índice único parcial de la migración 0121
    // exige que este orden se respete; si dos peticiones concurrentes intentaran certificar el mismo
    // impuesto, la segunda choca contra la restricción en vez de dejar dos vigentes.
    await tx.update(flitoImpuestoCertificaciones)
      .set({ vigente: false })
      .where(and(
        eq(flitoImpuestoCertificaciones.impuestoId, id),
        eq(flitoImpuestoCertificaciones.vigente, true),
      ));

    const [nueva] = await tx.insert(flitoImpuestoCertificaciones).values({
      impuestoId: id,
      vigente: true,
      placaConsultada: placa,
      // Se guarda el identificador que REALMENTE se usó, no los dos: el certificado tiene que poder
      // decir con qué se le preguntó al RUNT.
      documentoConsultado: documento,
      vinConsultado: documento ? null : vin,
      tipoDocPropietario: typeof tipoDocPropietario === 'string' ? tipoDocPropietario : null,
      // Se congela el nombre aunque no se compare: el certificado lo imprime, y un certificado que
      // cambia de contenido después de emitido no sirve como evidencia (HU #11167, AC2/AC4).
      propietarioNombre: datos.ownerName?.trim() || null,
      campos: veredicto.campos,
      snapshotRunt: runt.data as Record<string, unknown>,
      certificadoPorId: ctx.userId,
      certificadoPorNombre: ctx.username,
    }).returning();

    await tx.insert(auditLogs).values({
      userId: ctx.userId, userEmail: ctx.username, action: 'update',
      resource: 'flito_impuesto', resourceId: id,
      detail: `Certificación contra RUNT (placa ${placa}, ${documento ? `doc ${documento.slice(0, 4)}***` : `VIN ${vin}`})`,
    });

    return nueva;
  });

  log.info({ impuestoId: id, certificacionId: fila.id }, 'certificacion: ok');

  return {
    resultado: ResultadoCertificacion.CERTIFICADO,
    certificacion: {
      id: fila.id,
      impuestoId: fila.impuestoId,
      placaConsultada: fila.placaConsultada,
      documentoConsultado: fila.documentoConsultado,
      vinConsultado: fila.vinConsultado,
      tipoDocPropietario: fila.tipoDocPropietario,
      propietarioNombre: fila.propietarioNombre,
      campos: fila.campos as ComparacionCampo[],
      certificadoPorNombre: fila.certificadoPorNombre,
      createdAt: fila.createdAt.toISOString(),
    },
  };
}

/** Desenlace de UN registro dentro de un lote. Mismo vocabulario que la certificación individual. */
export interface ResultadoLoteItem {
  id: string;
  resultado: ResultadoCertificacion;
  mensaje?: string;
  motivo?: MotivoNoElegible;
  /** Solo en `con_diferencias`: lo que el gestor necesita leer para saber qué corregir. */
  diferenciasBloqueantes?: ComparacionCampo[];
}

/** Traduce un desenlace individual al item del lote, sin perder el detalle. */
function aItemLote(id: string, r: ResultadoCertificar): ResultadoLoteItem {
  switch (r.resultado) {
    case ResultadoCertificacion.CERTIFICADO:
      return { id, resultado: r.resultado };
    case ResultadoCertificacion.CON_DIFERENCIAS:
      return { id, resultado: r.resultado, diferenciasBloqueantes: r.diferenciasBloqueantes };
    case ResultadoCertificacion.NO_ELEGIBLE:
      return { id, resultado: r.resultado, motivo: r.motivo, mensaje: r.mensaje };
    default:
      return { id, resultado: r.resultado, mensaje: r.mensaje };
  }
}

/**
 * Certifica un lote de impuestos (HU #11166).
 *
 * Un registro que falla NO tumba el lote: cada uno devuelve su propio desenlace y el gestor ve en
 * una tabla cuáles quedaron y cuáles no. Por eso `certificarImpuesto` devuelve los fallos esperables
 * en vez de lanzarlos, y por eso aquí se atrapa lo que sí lanza (un id inaccesible) en lugar de
 * dejarlo propagar.
 *
 * Los ids duplicados se colapsan: certificar dos veces el mismo registro en un mismo lote gastaría
 * dos consultas al RUNT —que se cobran— para acabar dejando una sola certificación vigente.
 */
export async function certificarLote(ids: string[], ctx: ImpuestoCtx): Promise<ResultadoLoteItem[]> {
  const unicos = [...new Set(ids)];

  if (unicos.length === 0) throw new ImpuestoError(400, 'No se seleccionó ningún impuesto.');
  if (unicos.length > TOPE_LOTE_CERTIFICACION) {
    throw new ImpuestoError(400, `Máximo ${TOPE_LOTE_CERTIFICACION} impuestos por lote. Seleccionaste ${unicos.length}.`);
  }

  log.info({ total: unicos.length }, 'certificacion masiva: inicio');

  return conConcurrencia(unicos, CONCURRENCIA_CERTIFICACION, async (id): Promise<ResultadoLoteItem> => {
    try {
      return aItemLote(id, await certificarImpuesto(id, ctx));
    } catch (e) {
      // Un id que no existe o cae fuera de la frontera del gestor: en la ruta individual es un 404,
      // pero dentro de un lote es solo una fila que no se pudo procesar.
      if (e instanceof ImpuestoError) {
        return {
          id,
          resultado: ResultadoCertificacion.NO_ELEGIBLE,
          motivo: MotivoNoElegible.NO_ACCESIBLE,
          mensaje: e.message,
        };
      }
      // Cualquier otra cosa (un fallo de BD, por ejemplo) tampoco puede matar el lote entero.
      const mensaje = (e as Error)?.message || 'Error inesperado al certificar.';
      log.warn({ impuestoId: id, err: mensaje }, 'certificacion masiva: fallo inesperado');
      return { id, resultado: ResultadoCertificacion.ERROR_SERVICIO, mensaje };
    }
  });
}

/**
 * Certificación vigente respetando la frontera del gestor (HU #11167).
 *
 * Distingue dos negativas que NO son la misma: si el impuesto no existe o cae fuera de la frontera
 * lanza 404 —igual que el resto del módulo, sin revelar que el registro existe—; si existe pero no
 * está certificado devuelve `null`, y eso es un 409 en la ruta. Colapsar ambas en un 404 le diría al
 * gestor «no existe» de un registro que está viendo en pantalla.
 */
export async function certificacionVigenteConAcceso(impuestoId: string, ctx: ImpuestoCtx): Promise<CertificacionVigente | null> {
  const imp = await buscarConAcceso(impuestoId, ctx);
  if (!imp) throw new ImpuestoError(404, 'El impuesto no existe');
  return certificacionVigente(impuestoId);
}

/** Certificación vigente de un impuesto, o `null`. La usa el detalle y el certificado PDF. */
export async function certificacionVigente(impuestoId: string): Promise<CertificacionVigente | null> {
  const [row] = await db.select()
    .from(flitoImpuestoCertificaciones)
    .where(and(
      eq(flitoImpuestoCertificaciones.impuestoId, impuestoId),
      eq(flitoImpuestoCertificaciones.vigente, true),
    ))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    impuestoId: row.impuestoId,
    placaConsultada: row.placaConsultada,
    documentoConsultado: row.documentoConsultado,
    vinConsultado: row.vinConsultado,
    tipoDocPropietario: row.tipoDocPropietario,
    propietarioNombre: row.propietarioNombre,
    campos: row.campos as ComparacionCampo[],
    certificadoPorNombre: row.certificadoPorNombre,
    createdAt: row.createdAt.toISOString(),
  };
}
