// Dr. Flit — autorización de tratamiento de datos (Ley 1581). HU #13803, Feature #13695.
// Diseño: docs/diseno/feature-13695-dr-flit-soporte.md (D5, modelo de datos).
//
// RN-DRF-A1  Una autorización por usuario × finalidad × versión (UNIQUE en la 0245). Aceptar dos veces
//            la misma versión no crea otra fila: responde la existente.
// RN-DRF-A2  Solo vale la versión VIGENTE (`AUTORIZACIONES_DRFLIT` de shared-types). Otra versión →
//            `AutorizacionDrFlitError('version-no-vigente')` y no se guarda nada. Si la vigente cambia,
//            las aceptaciones anteriores dejan de contar (`autorizado=false`).
// RN-DRF-A3  Las finalidades son independientes: aceptar `soporte` no autoriza `ia`.
// RN-DRF-A4  Se guarda el SHA-256 del texto exacto aceptado, la fecha, la IP y el user agent. La tabla
//            es de SOLO INSERCIÓN (triggers de la 0245): este servicio nunca hace UPDATE ni DELETE.
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  AUTORIZACIONES_DRFLIT, type AutorizacionAceptadaDrFlit, type FinalidadDrFlit,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoDrflitAutorizaciones } from '../../db/schema/flito-drflit.js';

export class AutorizacionDrFlitError extends Error {
  constructor(readonly codigo: 'version-no-vigente', message: string) {
    super(message);
    this.name = 'AutorizacionDrFlitError';
  }
}

export interface FilaAutorizacion {
  id: number;
  version: string;
  aceptadaEn: Date;
}

export interface NuevaAutorizacion {
  usuarioId: number;
  finalidad: FinalidadDrFlit;
  version: string;
  textoSha256: string;
  ip: string | null;
  userAgent: string | null;
}

/** Conexión de Drizzle. Por defecto la del proceso; los tests contra PostgreSQL pasan la de su tx. */
export type ConexionAutorizaciones = Pick<typeof db, 'select' | 'insert'>;

/**
 * Acceso a datos. Objeto mutable a propósito: los tests HTTP sustituyen sus métodos con `vi.spyOn`
 * (el resto del repo mockea `db` con colas posicionales; aquí la consulta depende de la clave). Las
 * consultas reales se prueban contra PostgreSQL en `__tests__/db/migracion-0245.test.ts`.
 */
export const repoAutorizaciones = {
  async buscar(
    usuarioId: number, finalidad: FinalidadDrFlit, version: string, conexion: ConexionAutorizaciones = db,
  ): Promise<FilaAutorizacion | null> {
    const [fila] = await conexion.select({
      id: flitoDrflitAutorizaciones.id,
      version: flitoDrflitAutorizaciones.version,
      aceptadaEn: flitoDrflitAutorizaciones.aceptadaEn,
    }).from(flitoDrflitAutorizaciones).where(and(
      eq(flitoDrflitAutorizaciones.usuarioId, usuarioId),
      eq(flitoDrflitAutorizaciones.finalidad, finalidad),
      eq(flitoDrflitAutorizaciones.version, version),
    )).limit(1);
    return fila ?? null;
  },

  /** INSERT … ON CONFLICT DO NOTHING. `null` si ya existía (la tabla es de solo inserción). */
  async insertar(n: NuevaAutorizacion, conexion: ConexionAutorizaciones = db): Promise<FilaAutorizacion | null> {
    const [fila] = await conexion.insert(flitoDrflitAutorizaciones).values(n).onConflictDoNothing({
      target: [flitoDrflitAutorizaciones.usuarioId, flitoDrflitAutorizaciones.finalidad, flitoDrflitAutorizaciones.version],
    }).returning({
      id: flitoDrflitAutorizaciones.id,
      version: flitoDrflitAutorizaciones.version,
      aceptadaEn: flitoDrflitAutorizaciones.aceptadaEn,
    });
    return fila ?? null;
  },
};

export const versionVigente = (f: FinalidadDrFlit): string => AUTORIZACIONES_DRFLIT[f].version;
export const textoVigente = (f: FinalidadDrFlit): string => AUTORIZACIONES_DRFLIT[f].texto;
export const sha256Texto = (texto: string): string => createHash('sha256').update(texto, 'utf8').digest('hex');

/** Estado de la autorización VIGENTE del usuario para una finalidad. */
export async function estadoAutorizacion(
  usuarioId: number, finalidad: FinalidadDrFlit,
): Promise<{ autorizado: boolean; versionVigente: string; aceptadaEn: Date | null }> {
  const vigente = versionVigente(finalidad);
  const fila = await repoAutorizaciones.buscar(usuarioId, finalidad, vigente);
  return { autorizado: fila !== null, versionVigente: vigente, aceptadaEn: fila?.aceptadaEn ?? null };
}

/** Registra la aceptación. `nueva=false` si esa versión ya estaba aceptada (idempotente). */
export async function aceptarAutorizacion(
  usuarioId: number,
  finalidad: FinalidadDrFlit,
  version: string,
  origen: { ip: string | null; userAgent: string | null },
): Promise<{ nueva: boolean; id: number; aceptada: AutorizacionAceptadaDrFlit }> {
  const vigente = versionVigente(finalidad);
  if (version !== vigente) {
    throw new AutorizacionDrFlitError(
      'version-no-vigente',
      'La versión de la autorización ya no está vigente. Recargue el panel para ver el texto actual.',
    );
  }
  const insertada = await repoAutorizaciones.insertar({
    usuarioId, finalidad, version: vigente, textoSha256: sha256Texto(textoVigente(finalidad)),
    ip: origen.ip, userAgent: origen.userAgent,
  });
  const fila = insertada ?? await repoAutorizaciones.buscar(usuarioId, finalidad, vigente);
  if (!fila) throw new Error('autorización no encontrada tras el conflicto'); // no debería ocurrir: UNIQUE
  return {
    nueva: insertada !== null,
    id: fila.id,
    aceptada: { finalidad, version: fila.version, aceptadaEn: fila.aceptadaEn.toISOString() },
  };
}
