// Siigo API — credenciales cifradas (HU #11247, Feature #11239).
//
// El `access_key` de Siigo nunca se guarda ni se devuelve en claro. Se cifra con AES-256-GCM bajo
// una clave maestra propia (`SIIGO_ENC_KEY`), separada de la de RNDC y de la de PII: si una se
// compromete, las otras siguen protegidas.
//
// Dos decisiones que conviene no revertir sin pensarlo:
//
//   1. Sin llave maestra NO se opera. No hay derivación de respaldo en desarrollo, a diferencia de
//      RNDC. Derivar en silencio produciría credenciales cifradas con una clave distinta según el
//      entorno, y el día que se configurase la real dejarían de descifrar sin explicación.
//   2. Un descifrado fallido desactiva la credencial. Si el ciphertext no verifica, la fila está
//      corrupta o manipulada: seguir intentándola en cada petición solo produce ruido. Se desactiva,
//      se deja el motivo escrito en la propia fila y se exige que un administrador la reconfigure.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { siigoCredenciales } from '../../db/schema.js';
import {
  decryptSiigoSecret, encryptSiigoSecret, newUuid, Redacted, SiigoEncKeyError,
} from '../../shared/utils/crypto.js';

const TABLE = 'siigo_credenciales';
const COLUMN = 'access_key';

export type SiigoAmbiente = 'pruebas' | 'produccion';

/** Falla de negocio de las credenciales. El router la traduce a un status HTTP. */
export class SiigoCredencialError extends Error {
  readonly codigo: 'no_configurada' | 'llave_maestra' | 'ambiente_ambiguo' | 'descifrado';
  constructor(codigo: SiigoCredencialError['codigo'], message: string) {
    super(message);
    this.name = 'SiigoCredencialError';
    this.codigo = codigo;
  }
}

interface GuardarCredencialInput {
  ambiente: SiigoAmbiente;
  username: string;
  accessKey: string;
  notas?: string;
  userId: number;
}

/** Vista pública: todo lo necesario para administrar, nada del secreto. */
export interface SiigoCredencialPublica {
  id: number;
  ambiente: string;
  username: string;
  /** Siempre enmascarado. NUNCA el valor real. */
  accessKey: string;
  activo: boolean;
  keyVersion: number;
  notas: string | null;
  descifradoFallidoEn: Date | null;
  descifradoFallidoMotivo: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** El único valor de `accessKey` que sale de este módulo hacia afuera. */
const ACCESS_KEY_ENMASCARADA = '••••••••';

type FilaCredencial = typeof siigoCredenciales.$inferSelect;

function aPublica(row: Omit<FilaCredencial, 'accessKeyCipher' | 'accessKeyIv' | 'accessKeyAuthTag' | 'aadNonce' | 'createdBy' | 'updatedBy'>): SiigoCredencialPublica {
  return {
    id: row.id,
    ambiente: row.ambiente,
    username: row.username,
    accessKey: ACCESS_KEY_ENMASCARADA,
    activo: row.activo,
    keyVersion: row.keyVersion,
    notas: row.notas,
    descifradoFallidoEn: row.descifradoFallidoEn,
    descifradoFallidoMotivo: row.descifradoFallidoMotivo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Columnas de la vista pública. Excluye el cipher a nivel de consulta, no solo de mapeo. */
const SELECT_PUBLICO = {
  id: siigoCredenciales.id,
  ambiente: siigoCredenciales.ambiente,
  username: siigoCredenciales.username,
  activo: siigoCredenciales.activo,
  keyVersion: siigoCredenciales.keyVersion,
  notas: siigoCredenciales.notas,
  descifradoFallidoEn: siigoCredenciales.descifradoFallidoEn,
  descifradoFallidoMotivo: siigoCredenciales.descifradoFallidoMotivo,
  createdAt: siigoCredenciales.createdAt,
  updatedAt: siigoCredenciales.updatedAt,
} as const;

/**
 * Registra la credencial de un ambiente. Si ya había una activa, la desactiva y crea una nueva:
 * el historial se conserva y el índice único parcial sigue cumpliéndose.
 *
 * Se cifra ANTES de abrir la transacción a propósito. Si falta la llave maestra, esto revienta sin
 * haber tocado la base de datos, que es justo lo que pide AC4: no queda nada a medio cifrar.
 */
export async function guardarCredencial(input: GuardarCredencialInput): Promise<SiigoCredencialPublica> {
  const aadNonce = newUuid();
  const bundle = encryptSiigoSecret(input.accessKey, {
    table: TABLE, column: COLUMN, empresaNit: input.ambiente, aadNonce,
  });

  return await db.transaction(async (tx) => {
    await tx.update(siigoCredenciales)
      .set({ activo: false, updatedBy: input.userId, updatedAt: new Date() })
      .where(and(
        eq(siigoCredenciales.ambiente, input.ambiente),
        eq(siigoCredenciales.activo, true),
      ));

    const [creada] = await tx.insert(siigoCredenciales).values({
      ambiente: input.ambiente,
      username: input.username,
      accessKeyCipher: bundle.cipher,
      accessKeyIv: bundle.iv,
      accessKeyAuthTag: bundle.authTag,
      aadNonce,
      keyVersion: bundle.keyVersion,
      activo: true,
      notas: input.notas ?? null,
      createdBy: input.userId,
      updatedBy: input.userId,
    }).returning();

    return aPublica(creada);
  });
}

export async function listarCredenciales(): Promise<SiigoCredencialPublica[]> {
  const rows = await db.select(SELECT_PUBLICO).from(siigoCredenciales)
    .orderBy(siigoCredenciales.ambiente, sql`${siigoCredenciales.id} DESC`);
  return rows.map((r) => aPublica({ ...r, descifradoFallidoEn: r.descifradoFallidoEn }));
}

export async function desactivarCredencial(id: number, userId: number): Promise<boolean> {
  const r = await db.update(siigoCredenciales)
    .set({ activo: false, updatedBy: userId, updatedAt: new Date() })
    .where(eq(siigoCredenciales.id, id))
    .returning({ id: siigoCredenciales.id });
  return r.length > 0;
}

export interface CredencialResuelta {
  id: number;
  ambiente: SiigoAmbiente;
  username: string;
  /** Envuelta para que un log accidental imprima [REDACTED] en vez del secreto. */
  accessKey: Redacted<string>;
}

/**
 * USO RESTRINGIDO: solo el cliente HTTP de Siigo. Devuelve la credencial activa del ambiente con el
 * `access_key` descifrado y envuelto en `Redacted`.
 *
 * Lanza `SiigoCredencialError` en los tres modos de fallo que la HU distingue, porque quien llama
 * necesita poder decir cuál ocurrió:
 *   - `no_configurada`   — no hay credencial activa para ese ambiente.
 *   - `ambiente_ambiguo` — hay más de una activa (solo posible si alguien tocó la BD saltándose
 *                          el índice único; se rechaza en vez de elegir una al azar).
 *   - `descifrado`       — el ciphertext no verifica. La credencial queda desactivada.
 *   - `llave_maestra`    — falta `SIIGO_ENC_KEY` o es inválida.
 */
export async function obtenerCredencialActiva(ambiente: SiigoAmbiente): Promise<CredencialResuelta> {
  const filas = await db.select().from(siigoCredenciales)
    .where(and(
      eq(siigoCredenciales.ambiente, ambiente),
      eq(siigoCredenciales.activo, true),
    ))
    .limit(2);

  if (filas.length === 0) {
    throw new SiigoCredencialError(
      'no_configurada',
      `No hay credenciales de Siigo activas para el ambiente "${ambiente}". Regístralas en la administración de la integración.`,
    );
  }
  if (filas.length > 1) {
    throw new SiigoCredencialError(
      'ambiente_ambiguo',
      `Hay más de una credencial de Siigo activa para el ambiente "${ambiente}". Deja solo una activa antes de continuar.`,
    );
  }

  const row = filas[0]!;
  let accessKey: string;
  try {
    accessKey = decryptSiigoSecret({
      cipher: row.accessKeyCipher,
      iv: row.accessKeyIv,
      authTag: row.accessKeyAuthTag,
      keyVersion: row.keyVersion,
    }, {
      table: TABLE, column: COLUMN, empresaNit: row.ambiente, aadNonce: row.aadNonce,
    });
  } catch (e) {
    // Falta la llave maestra: la fila está sana, no hay nada que desactivar. Desactivarla aquí
    // borraría una credencial buena solo porque el entorno está mal configurado.
    if (e instanceof SiigoEncKeyError) {
      throw new SiigoCredencialError('llave_maestra', e.message);
    }
    const motivo = e instanceof Error ? e.message : String(e);
    await marcarDescifradoFallido(row.id, motivo);
    throw new SiigoCredencialError(
      'descifrado',
      `La credencial de Siigo del ambiente "${ambiente}" no pudo descifrarse y quedó desactivada. `
      + 'Regístrala de nuevo desde la administración de la integración.',
    );
  }

  return {
    id: row.id,
    ambiente: row.ambiente as SiigoAmbiente,
    username: row.username,
    accessKey: new Redacted(accessKey),
  };
}

/**
 * Deja el fallo escrito en la fila y la desactiva. Si esta escritura falla no se propaga: el error
 * que importa es el del descifrado, y taparlo con un fallo de base de datos solo confunde.
 */
async function marcarDescifradoFallido(id: number, motivo: string): Promise<void> {
  try {
    await db.update(siigoCredenciales)
      .set({
        activo: false,
        descifradoFallidoEn: new Date(),
        descifradoFallidoMotivo: motivo.slice(0, 200),
        updatedAt: new Date(),
      })
      .where(eq(siigoCredenciales.id, id));
  } catch (e) {
    console.error('[siigo] no se pudo marcar el descifrado fallido de la credencial', id, e);
  }
}
