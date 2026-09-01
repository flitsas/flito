// FLITO — SOAT, canal Cliente: lectura del RUNT y verificación post-alta (HU #11935).
// Diseño: docs/diseno-hu-11935-alta-sin-runt-bloqueante.md · ADR-0009.
//
// El ALTA ya no espera a Kyverum. Este archivo concentra lo que sí habla con el RUNT:
// el extractor (el mismo de siempre, no se reescribe), la preconsulta (sigue bloqueante:
// su contrato HTTP no cambia) y el job fire-and-forget que corre DESPUÉS del COMMIT.
//
// El payload crudo no se persiste (ADR-0008 §1.6, esa frase se conserva). Solo derivados.

import { eq } from 'drizzle-orm';
import {
  CodigoErrorSolicitudSoat,
  resolverCodigoOrganismoFlit,
  type EstadoVerificacionSolicitudSoat,
  type TipoDocumentoRunt,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  auditLogs,
  flitoCompradores,
  flitoSoat,
  flitoSoatSolicitud,
  organismosTransitoConfig,
  vehicles,
} from '../../db/schema.js';
import { extraerVehiculoRunt, normalizarIdentificador, runtSinRegistro } from '../flito-impuestos/certificacion-runt.js';
import { derivePreflightChecks } from '../tramites/preflight.js';
import { consultarVehiculoRunt } from '../runt/runt.service.js';
import { mapTipoDocUiToRunt } from '../runt/runt-tipo-doc.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-soat-cliente');

/**
 * Lo que el canal necesita del RUNT. `null` en un campo significa «el RUNT no lo trajo», y no se
 * inventa: `vehicles` guarda null y la pantalla pinta «—».
 */
export interface DatosRuntCanal {
  placa: string | null;
  vin: string | null;
  marca: string | null;
  linea: string | null;
  /** Año-modelo. Texto aquí; `vehicles.year` es integer y la conversión se hace al escribir. */
  modelo: string | null;
  clase: string | null;
  cilindraje: string | null;
  tipoServicio: string | null;
  organismoNombre: string | null;
  /**
   * Nombre del propietario SI el RUNT lo trae.
   *
   * Riesgo abierto 2 del ADR-0008, y por eso este campo es opcional en el sentido fuerte: hay dos
   * afirmaciones contradictorias en el repo sobre si el RUNT devuelve al propietario
   * (`certificacion-runt.ts:11` dice que no; `soat/refresh.service.ts:111` lo lee de
   * `vehiculo.nombrePropietario`). El canal NO depende de la respuesta: el propietario que se
   * PERSISTE es el que teclea el cliente, y esto viaja solo en la preconsulta, para que el
   * formulario pueda pre-rellenar el nombre cuando exista. Correo, dirección y teléfono no vienen
   * por ninguna vía y siempre los teclea la persona.
   */
  propietarioNombre: string | null;
}

/** Lo que el alta escribe en `vehicles` ANTES de consultar el RUNT: placa/VIN/propietario, nada técnico. */
export const DATOS_RUNT_VACIOS: DatosRuntCanal = {
  placa: null, vin: null, marca: null, linea: null, modelo: null, clase: null,
  cilindraje: null, tipoServicio: null, organismoNombre: null, propietarioNombre: null,
};

/** Primer alias con valor útil. El RUNT no es consistente con los nombres de sus campos. */
function alias(fuente: Record<string, unknown> | null, claves: readonly string[]): string | null {
  if (!fuente) return null;
  for (const k of claves) {
    const v = fuente[k];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s.length > 0 && s.toLowerCase() !== 'null') return s;
  }
  return null;
}

/**
 * Los diez campos del canal, a partir de la respuesta cruda.
 *
 * Los seis primeros salen de `extraerVehiculoRunt`, que es el extractor que ya resuelve los alias
 * del RUNT y está verificado contra una consulta real (`certificacion-runt.ts`). NO se reescribe:
 * duplicar las cadenas de alias es garantizar que dentro de un mes digan cosas distintas. Los
 * cuatro que faltan —cilindraje, servicio, organismo y propietario— no están en `DatosVehiculoRunt`
 * porque la certificación de impuestos no los compara, y se leen aquí con el mismo criterio.
 */
export function extraerDatosCanal(data: unknown): DatosRuntCanal {
  const d = (data ?? {}) as Record<string, unknown>;
  const veh = (d.vehiculo ?? null) as Record<string, unknown> | null;
  const tec = (d.datosTecnicos ?? null) as Record<string, unknown> | null;
  const base = extraerVehiculoRunt(data);

  return {
    ...base,
    cilindraje: alias(veh, ['cilindraje', 'cilindrada']) ?? alias(tec, ['cilindraje', 'cilindrada']),
    tipoServicio: alias(veh, ['tipoServicio', 'servicio', 'nombreServicio'])
      ?? alias(tec, ['tipoServicio', 'servicio', 'nombreServicio']),
    organismoNombre: alias(veh, ['organismoTransito', 'organismoTransitoNombre', 'nombreOrganismoTransito']),
    propietarioNombre: alias(veh, ['nombrePropietario', 'propietario', 'nombreTitular']),
  };
}

/**
 * ¿El RUNT dice que este vehículo YA tiene SOAT vigente?
 *
 * Se delega en `derivePreflightChecks`. Solo `status === 'ok'` cuenta como vigente. `fail` es
 * «lo tuvo y está vencido»; `unknown` es «el RUNT no reporta póliza».
 */
export function soatVigenteSegunRunt(respuestaRunt: unknown): boolean {
  const { checks } = derivePreflightChecks({ vehiculoResp: respuestaRunt as { ok?: boolean; data?: unknown } });
  return checks.find((c) => c.key === 'soat')?.status === 'ok';
}

/**
 * La fecha hasta la que el RUNT dice que la póliza está vigente, en `yyyy-mm-dd`, o `null`.
 *
 * No se saca del `message` del check. Se leen los mismos alias que lee el pre-vuelo
 * (`fechaVencimSoat` / `fechaVencimiento`). Si el RUNT no manda fecha o manda algo que no es una
 * fecha, `null` — ninguna fecha por defecto.
 */
export function fechaVencimientoSoatRunt(data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const bruto = Array.isArray(d.soat) ? d.soat[0] : d.soat;
  const soat = (bruto ?? null) as Record<string, unknown> | null;
  const valor = alias(soat, ['fechaVencimSoat', 'fechaVencimiento']);
  if (!valor) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor);
  if (iso) return fechaValida(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(valor.trim());
  if (dmy) return fechaValida(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  return null;
}

/** `yyyy-mm-dd` si los tres números son un día del calendario; `null` si no. */
function fechaValida(anio: number, mes: number, dia: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || anio < 1900 || anio > 2200) return null;
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * El organismo del RUNT, traducido a código DIVIPOLA y comprobado contra la tabla.
 *
 * Dos comprobaciones: `resolverCodigoOrganismoFlit` cruza el nombre contra el catálogo nacional,
 * y `organismos_transito_config` es la tabla a la que apunta la FK. Devuelve `null` si no cruza
 * — el job NO lanza: deja el organismo NULL y anota `organismo_no_catalogado`.
 */
export async function resolverOrganismoCatalogo(nombre: string | null): Promise<string | null> {
  const codigo = resolverCodigoOrganismoFlit({ nombre });
  if (!codigo) return null;
  const [fila] = await db.select({ codigo: organismosTransitoConfig.codigo })
    .from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, codigo)).limit(1);
  return fila?.codigo ?? null;
}

/**
 * Placa o VIN del RUNT DIFIERE de la entrada. Un campo que el RUNT no trajo (`NO_VERIFICABLE`)
 * no es «no cuadra» — misma normalización que `compararCampo` de certificación.
 */
export function runtNoCuadra(
  entrada: { placa: string; vin: string },
  datos: DatosRuntCanal,
): boolean {
  const placaRunt = normalizarIdentificador(datos.placa);
  const vinRunt = normalizarIdentificador(datos.vin);
  const placaIn = normalizarIdentificador(entrada.placa);
  const vinIn = normalizarIdentificador(entrada.vin);
  if (placaRunt !== null && placaIn !== null && placaRunt !== placaIn) return true;
  if (vinRunt !== null && vinIn !== null && vinRunt !== vinIn) return true;
  return false;
}

export interface ResultadoRunt {
  datos: DatosRuntCanal;
  organismoCodigo: string;
}

export type RespuestaKyverum = { ok?: boolean; data?: unknown; message?: string };

/**
 * Consulta Kyverum. No clasifica: quien llama decide si lanza (preconsulta) o persiste (job).
 *
 * Bug #11927: la pasarela exige documento cuando va la placa; el VIN al lado no lo sustituye.
 */
export async function consultarRuntCrudo(
  placa: string,
  vin: string,
  numeroDocumento: string,
  tipoDocumento: TipoDocumentoRunt,
): Promise<RespuestaKyverum> {
  const tipoRunt = mapTipoDocUiToRunt(tipoDocumento) ?? tipoDocumento;
  return await consultarVehiculoRunt(placa, vin, numeroDocumento, tipoRunt) as RespuestaKyverum;
}

interface ClasificacionRunt {
  estado: EstadoVerificacionSolicitudSoat;
  codigo: string | null;
  soatVigente: boolean | null;
  soatVigenteHasta: string | null;
  datos: DatosRuntCanal | null;
  organismoCodigo: string | null;
}

function clasificarCaido(): ClasificacionRunt {
  return {
    estado: 'caido',
    codigo: CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE,
    soatVigente: null, soatVigenteHasta: null, datos: null, organismoCodigo: null,
  };
}

async function clasificarRespuesta(
  respuesta: RespuestaKyverum,
  entrada: { placa: string; vin: string },
): Promise<ClasificacionRunt> {
  if (!respuesta?.ok) return clasificarCaido();
  if (runtSinRegistro(respuesta.data)) {
    return {
      estado: 'sin_registro',
      codigo: CodigoErrorSolicitudSoat.RUNT_SIN_REGISTRO,
      soatVigente: null, soatVigenteHasta: null, datos: null, organismoCodigo: null,
    };
  }
  const datos = extraerDatosCanal(respuesta.data);
  if (runtNoCuadra(entrada, datos)) {
    return {
      estado: 'no_cuadra',
      codigo: CodigoErrorSolicitudSoat.RUNT_NO_CUADRA,
      soatVigente: null, soatVigenteHasta: null, datos, organismoCodigo: null,
    };
  }
  const vigente = soatVigenteSegunRunt(respuesta);
  const hasta = vigente ? fechaVencimientoSoatRunt(respuesta.data) : null;
  const organismoCodigo = await resolverOrganismoCatalogo(datos.organismoNombre);
  return {
    estado: 'ok',
    codigo: organismoCodigo ? null : CodigoErrorSolicitudSoat.ORGANISMO_NO_CATALOGADO,
    soatVigente: vigente,
    soatVigenteHasta: hasta,
    datos,
    organismoCodigo,
  };
}

/**
 * Rellena `vehicles` SOLO con campos RUNT que traen valor. No toca `owner_*` (ADR-0008 §1.4
 * al revés: el job no pisa al propietario que tecleó el cliente). `null` no borra lo que ya
 * se sabía.
 */
async function rellenarVehiculoDesdeRunt(
  vehiculoId: number,
  datos: DatosRuntCanal,
  soatId: string,
  userId: number | null,
  userEmail: string,
): Promise<void> {
  const anio = Number(datos.modelo);
  const year = Number.isInteger(anio) && anio > 1900 && anio < 2200 ? anio : null;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (datos.marca) set.brand = datos.marca;
  if (datos.linea) set.model = datos.linea;
  if (year !== null) set.year = year;
  if (datos.clase) set.vehicleClass = datos.clase;
  if (datos.cilindraje) set.cilindraje = datos.cilindraje;
  if (datos.tipoServicio) set.tipoServicio = datos.tipoServicio;
  const tecnicos = Object.keys(set).filter((k) => k !== 'updatedAt');
  if (tecnicos.length === 0) return;

  await db.update(vehicles).set(set).where(eq(vehicles.id, vehiculoId));
  await db.insert(auditLogs).values({
    userId, userEmail, action: 'update', resource: 'vehicles',
    resourceId: String(vehiculoId),
    detail: `Verificación RUNT post-alta de solicitud SOAT del canal Cliente (${soatId}): ficha del vehículo rellenada con los datos del RUNT`,
  });
}

/**
 * Verificación post-COMMIT. Cierra sobre el id, no sobre el documento. Una sola pasada.
 *
 * Si `verificacion_estado !== 'pendiente'`, return (idempotente). Si el proceso muere entre el
 * COMMIT y este job, la fila se queda en `pendiente` y Operaciones valida a mano (AC6).
 *
 * El log es `{ soatId, verificacionEstado }`. Prohibido placa, VIN, documento, nombre.
 */
export async function verificarRuntPostAlta(soatId: string): Promise<void> {
  const [fila] = await db
    .select({
      soatId: flitoSoat.id,
      vin: flitoSoat.vin,
      vehiculoId: flitoSoat.vehiculoId,
      placa: vehicles.plate,
      verificacionEstado: flitoSoatSolicitud.verificacionEstado,
      solicitadoPorId: flitoSoatSolicitud.solicitadoPorId,
      solicitadoPorNombre: flitoSoatSolicitud.solicitadoPorNombre,
      tipoDocumento: flitoCompradores.tipoDocumento,
      numeroDocumento: flitoCompradores.numeroDocumento,
    })
    .from(flitoSoat)
    .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .innerJoin(flitoSoatSolicitud, eq(flitoSoatSolicitud.soatId, flitoSoat.id))
    .innerJoin(flitoCompradores, eq(flitoCompradores.soatId, flitoSoat.id))
    .where(eq(flitoSoat.id, soatId))
    .limit(1);

  if (!fila) return;
  if (fila.verificacionEstado !== 'pendiente') return;

  const placa = fila.placa ?? '';
  const vin = fila.vin;
  const documento = fila.numeroDocumento ?? '';
  const tipo = (fila.tipoDocumento ?? 'CC') as TipoDocumentoRunt;

  let clasificacion: ClasificacionRunt;
  try {
    const respuesta = await consultarRuntCrudo(placa, vin, documento, tipo);
    clasificacion = await clasificarRespuesta(respuesta, { placa, vin });
  } catch {
    clasificacion = clasificarCaido();
  }

  const ahora = new Date();
  await db.update(flitoSoatSolicitud).set({
    verificacionEstado: clasificacion.estado,
    soatVigente: clasificacion.soatVigente,
    soatVigenteHasta: clasificacion.soatVigenteHasta,
    verificacionCodigo: clasificacion.codigo,
    updatedAt: ahora,
  }).where(eq(flitoSoatSolicitud.soatId, soatId));

  if (clasificacion.estado === 'ok' && clasificacion.datos) {
    await rellenarVehiculoDesdeRunt(
      fila.vehiculoId,
      clasificacion.datos,
      soatId,
      fila.solicitadoPorId,
      fila.solicitadoPorNombre,
    );
    if (clasificacion.organismoCodigo) {
      await db.update(flitoSoat).set({
        organismoCodigo: clasificacion.organismoCodigo,
        updatedAt: ahora,
      }).where(eq(flitoSoat.id, soatId));
    }
  }

  log.info({ soatId, verificacionEstado: clasificacion.estado }, 'verificacion RUNT post-alta');
}

/**
 * Fire-and-forget tras el COMMIT del alta. Precedente: `tramites/lote.ts` (`setImmediate`).
 * Sin cola Redis. El 201 no espera.
 */
export function programarVerificacionRunt(soatId: string): void {
  setImmediate(() => {
    verificarRuntPostAlta(soatId).catch((err: unknown) => {
      const mensaje = err instanceof Error ? err.message : 'error';
      log.warn({ soatId, err: mensaje }, 'verificacion RUNT post-alta fallo');
    });
  });
}
