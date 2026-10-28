// HU #14132 (Feature #14013, ADR-0032, riesgo R-3) — la costura entre la fila del lote y el alta de la Renovación.
//
// Crea la Renovación IGUAL que el alta individual sin factura (HU #14017, `crearSolicitud`): mismas guardas
// (RN-01 con el terminal propio como antecesor, tenencia del vehículo), mismo `upsertVehiculoRunt`, mismo
// despacho (`insertarSolicitudDespachada`: destino de la compañía, `solicitado`, historial) y el propietario en
// `flito_compradores` orden 0. Diferencias deliberadas, todas por lo que la plantilla trae (Placa, Documento,
// Nombre, Correo, Celular):
//   · el id del SOAT es el `soat_id_reservado` que se fijó al reclamar la fila (idempotencia, AC9);
//   · NOMBRE COMPLETO en `nombres`, `apellidos` y `razon_social` nulos, `nombre_completo` = el nombre: el archivo
//     trae una sola columna y dividirla sería inventar datos (el CHECK `titular_chk` lo admite);
//   · tipo de documento, dirección, municipio y departamento quedan `null` (no vienen en el archivo);
//   · la fila queda `aceptada` en la MISMA transacción que el SOAT: o están las dos cosas o ninguna.
// `crearSolicitud` vive en un archivo congelado en su techo y mezcla multipart/S3; por eso esta orquestación es
// nueva y reutiliza solo sus primitivas exportadas.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoCompradores, flitoSoatMasivoFilas as F, flitoSoatMasivoLotes as L } from '../../db/schema.js';
import {
  insertarSolicitudDespachada, proyectarSoatActivo, upsertVehiculoRunt, verificarRn01, verificarTenenciaVehiculo,
  type CanalCompania, type PropietarioSolicitud,
} from './flito-soat-cliente.service.js';
import type { DesenlaceRunt } from './flito-soat-cliente-runt.js';
import type { SoatCtx } from './flito-soat.service.js';
import { aparcarSolicitud, type PropietarioAparcable } from './flito-soat-incompletas.service.js';
import { procedenciaCompleta } from './flito-soat-cliente.service.js';
import type { FilaReclamada } from './flito-soat-masivo-reclamo.js';

/** La fila dejó de estar `consultando` (p. ej. la cerró el vigilante): se revierte lo creado. */
export class FilaYaNoVigenteError extends Error {
  constructor() { super('fila_ya_no_vigente'); this.name = 'FilaYaNoVigenteError'; }
}

export const propietarioDeFila = (f: FilaReclamada): PropietarioAparcable => ({
  tipoDocumento: null, numeroDocumento: f.documento ?? '',
  nombres: f.nombre, apellidos: null, razonSocial: null,
  correo: f.correo ?? '', celular: f.celular ?? '',
  direccion: null, municipio: null, departamento: null,
});

/**
 * HU #14134: marca, línea y modelo que devolvió el RUNT (los mismos de `DatosRuntCanal`), para la tabla de avance.
 * Solo si el RUNT los trajo (`null` = no se inventa). El modelo va a `smallint`: texto no numérico → null.
 */
export function vehiculoDeDesenlace(d: DesenlaceRunt): Partial<typeof F.$inferInsert> {
  if (d.clase !== 'ok' && d.clase !== 'renovacion_anticipada') return {};
  const modelo = Number.parseInt(d.datos.modelo ?? '', 10);
  return {
    vehiculoMarca: d.datos.marca?.trim().slice(0, 60) || null,
    vehiculoLinea: d.datos.linea?.trim().slice(0, 80) || null,
    vehiculoModelo: Number.isInteger(modelo) && modelo >= 1900 && modelo <= 2100 ? modelo : null,
  };
}

/** Marca la fila como terminada (y el avance del lote). `false` si ya no estaba `consultando`. */
export async function marcarFila(
  id: string, loteId: string, cambios: Partial<typeof F.$inferInsert>, terminal: boolean,
  tx: Pick<typeof db, 'update'> = db,
): Promise<boolean> {
  const r = await tx.update(F).set({ ...cambios, reclamadaEn: null })
    .where(and(eq(F.id, id), eq(F.estado, 'consultando'))).returning({ id: F.id });
  if (r.length > 0 && terminal) await tx.update(L).set({ ultimoAvanceEn: sql`now()` }).where(eq(L.id, loteId));
  return r.length > 0;
}

export async function crearRenovacionDeFila(p: {
  fila: FilaReclamada; canal: CanalCompania; ctx: SoatCtx;
  desenlace: Extract<DesenlaceRunt, { clase: 'ok' | 'renovacion_anticipada' }>;
}): Promise<string> {
  const { fila, canal, ctx, desenlace } = p;
  const companiaId = canal.companiaId;
  const vin = desenlace.vinEfectivo;
  // Renovación: un SOAT `pagado` propio NO bloquea y se enlaza; uno abierto es 409 y uno ajeno el 409 recortado.
  const antecesor = await verificarRn01(vin, companiaId, { permiteTerminal: true });
  await verificarTenenciaVehiculo(vin, companiaId);

  const vigenciaProxima = desenlace.clase === 'renovacion_anticipada'
    ? { venceEl: desenlace.venceEl, ...proyectarSoatActivo(desenlace.soatActivo) }
    : null;
  const soatId = fila.soatIdReservado;
  const ahora = new Date();
  const propietario = propietarioDeFila(fila);

  await db.transaction(async (tx) => {
    // `upsertVehiculoRunt` solo lee el documento y el nombre del propietario: el resto del tipo no se persiste ahí.
    const vehiculoId = await upsertVehiculoRunt(
      tx, { vin }, desenlace.datos, propietario as unknown as PropietarioSolicitud, companiaId, ctx, soatId,
    );
    await insertarSolicitudDespachada(tx, {
      soatId, tipoSoat: 'renovacion', soatAnteriorId: antecesor?.id ?? null, vin, vehiculoId, companiaId,
      organismoCodigo: desenlace.organismoCodigo, vigenciaProxima, consultadoEn: ahora, ahora, factura: null,
      solicitante: { id: ctx.userId, nombre: ctx.username, en: null },
    }, ctx);
    await tx.insert(flitoCompradores).values({
      soatId,
      nombreCompleto: fila.nombre ?? '',
      nombres: propietario.nombres, apellidos: null, razonSocial: null,
      numeroDocumento: propietario.numeroDocumento, tipoDocumento: null,
      correo: propietario.correo, celular: propietario.celular,
      direccion: null, municipio: null, departamento: null,
      procedencia: procedenciaCompleta(null),
      orden: 0,
    });
    const ok = await marcarFila(fila.id, fila.loteId, { estado: 'aceptada', soatId, ...vehiculoDeDesenlace(desenlace) }, true, tx);
    if (!ok) throw new FilaYaNoVigenteError();
  });
  return soatId;
}

/** Aparca la fila en «Por validar» (`runt_sin_respuesta`, modalidad placa, sin factura) con su propietario. */
export async function aparcarFila(p: {
  fila: FilaReclamada; canal: CanalCompania; ctx: SoatCtx; intentos: number; causa: string;
}): Promise<'aparcada' | 'ocupada'> {
  const { fila, canal, ctx } = p;
  const r = await aparcarSolicitud({
    tipoSoat: 'renovacion', modalidad: 'placa', vin: null,
    placa: (fila.placa ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    companiaId: canal.companiaId, carpetaStorage: canal.carpetaStorage,
    propietario: propietarioDeFila(fila), nombreCompleto: fila.nombre ?? '',
    procedencia: procedenciaCompleta(null), archivo: null, soatIdReservado: fila.soatIdReservado,
  }, ctx);
  if (!r.aparcada) return 'ocupada';
  await marcarFila(fila.id, fila.loteId, {
    estado: 'por_validar', incompletaId: r.id, intentos: p.intentos, ultimaCausa: p.causa,
  }, true);
  return 'aparcada';
}
