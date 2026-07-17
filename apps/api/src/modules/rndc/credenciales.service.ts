import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { rndcCredenciales } from '../../db/schema.js';
import { encryptSecret, decryptSecret, newUuid, Redacted } from '../../shared/utils/crypto.js';
import { RndcCredentials } from './client/types.js';

const TABLE = 'rndc_credenciales';
const COLUMN = 'clave_qr';

interface SetCredencialesInput {
  empresaNit: string;
  habilitadorNit: string;
  numNit: string;
  claveQR: string;
  ambiente: 'sandbox' | 'produccion';
  notas?: string;
  userId: number;
}

export interface CredencialPublic {
  id: number;
  empresaNit: string;
  habilitadorNit: string;
  numNit: string;
  ambiente: string;
  activo: boolean;
  notas: string | null;
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

// Inserta o reemplaza la credencial activa para (empresa_nit, ambiente).
// Si ya existe activa, la marca activo=false y crea una nueva (preserva historial).
export async function setCredenciales(input: SetCredencialesInput): Promise<CredencialPublic> {
  const aadNonce = newUuid();
  const bundle = encryptSecret(input.claveQR, {
    table: TABLE, column: COLUMN,
    empresaNit: input.empresaNit, aadNonce,
  });

  return await db.transaction(async (tx) => {
    // Desactivar credenciales previas activas del mismo (empresa, ambiente).
    await tx.update(rndcCredenciales)
      .set({ activo: false, updatedBy: input.userId, updatedAt: new Date() })
      .where(and(
        eq(rndcCredenciales.empresaNit, input.empresaNit),
        eq(rndcCredenciales.ambiente, input.ambiente),
        eq(rndcCredenciales.activo, true),
      ));

    const [created] = await tx.insert(rndcCredenciales).values({
      empresaNit: input.empresaNit,
      habilitadorNit: input.habilitadorNit,
      numNit: input.numNit,
      claveQrCipher: bundle.cipher,
      claveQrIv: bundle.iv,
      claveQrAuthTag: bundle.authTag,
      aadNonce,
      keyVersion: bundle.keyVersion,
      ambiente: input.ambiente,
      activo: true,
      notas: input.notas ?? null,
      createdBy: input.userId,
      updatedBy: input.userId,
    }).returning();

    return {
      id: created.id,
      empresaNit: created.empresaNit,
      habilitadorNit: created.habilitadorNit,
      numNit: created.numNit,
      ambiente: created.ambiente,
      activo: created.activo,
      notas: created.notas,
      keyVersion: created.keyVersion,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  });
}

export async function listCredencialesPublic(): Promise<CredencialPublic[]> {
  const rows = await db.select({
    id: rndcCredenciales.id,
    empresaNit: rndcCredenciales.empresaNit,
    habilitadorNit: rndcCredenciales.habilitadorNit,
    numNit: rndcCredenciales.numNit,
    ambiente: rndcCredenciales.ambiente,
    activo: rndcCredenciales.activo,
    notas: rndcCredenciales.notas,
    keyVersion: rndcCredenciales.keyVersion,
    createdAt: rndcCredenciales.createdAt,
    updatedAt: rndcCredenciales.updatedAt,
  }).from(rndcCredenciales).orderBy(rndcCredenciales.empresaNit, rndcCredenciales.ambiente);
  return rows;
}

export async function deactivateCredencial(id: number, userId: number): Promise<boolean> {
  const r = await db.update(rndcCredenciales)
    .set({ activo: false, updatedBy: userId, updatedAt: new Date() })
    .where(eq(rndcCredenciales.id, id))
    .returning({ id: rndcCredenciales.id });
  return r.length > 0;
}

// USO RESTRINGIDO: solo desde envio.service.ts. Devuelve credenciales con clave en claro
// envueltas en Redacted<T> para evitar leak por log accidental.
export async function getActiveCredenciales(
  empresaNit: string, ambiente: 'sandbox' | 'produccion',
): Promise<{ creds: RndcCredentials; redactedClave: Redacted<string> } | null> {
  const [row] = await db.select().from(rndcCredenciales)
    .where(and(
      eq(rndcCredenciales.empresaNit, empresaNit),
      eq(rndcCredenciales.ambiente, ambiente),
      eq(rndcCredenciales.activo, true),
    ))
    .limit(1);
  if (!row) return null;

  const claveQR = decryptSecret({
    cipher: row.claveQrCipher,
    iv: row.claveQrIv,
    authTag: row.claveQrAuthTag,
    keyVersion: row.keyVersion,
  }, {
    table: TABLE, column: COLUMN,
    empresaNit: row.empresaNit, aadNonce: row.aadNonce,
  });

  return {
    creds: {
      empresaNit: row.empresaNit,
      habilitadorNit: row.habilitadorNit,
      numNit: row.numNit,
      claveQR,
      ambiente: row.ambiente as 'sandbox' | 'produccion',
    },
    redactedClave: new Redacted(claveQR),
  };
}
