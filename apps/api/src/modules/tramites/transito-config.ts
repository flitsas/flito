import {
  ORGANISMOS_TRANSITO,
  getOrganismoByCodigo,
  isKnownOrganismoCodigo,
  type OrganismoTransito,
} from '@operaciones/shared-types';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { organismosTransitoConfig, users } from '../../db/schema.js';

export interface OrganismoConfigDto {
  codigo: string;
  nombre: string;
  ciudad: string;
  alias: string | null;
  /** Src resuelto para <img>: logo subido (ruta API) o URL externa legacy. */
  logoUrl: string | null;
  /** TRAM-MT-02 Fase 2b: URL externa cruda (campo editable de la UI). */
  logoUrlExterno: string | null;
  /** Presente si hay logo subido a MinIO (la UI muestra «quitar»). */
  logoStorageKey: string | null;
  activo: boolean;
  userCount: number;
  updatedAt: string | null;
}

/** Ruta API relativa que sirve el logo subido (sirve con cookie de sesión). */
export function logoApiPath(codigo: string): string {
  return `/api/transito/organismos-config/${codigo}/logo`;
}

function mergeRow(catalog: OrganismoTransito, row?: {
  alias: string | null;
  logoUrl: string | null;
  logoStorageKey: string | null;
  activo: boolean;
  updatedAt: Date;
} | null, userCount = 0): OrganismoConfigDto {
  const storageKey = row?.logoStorageKey ?? null;
  const externo = row?.logoUrl ?? null;
  return {
    codigo: catalog.codigo,
    nombre: catalog.nombre,
    ciudad: catalog.ciudad,
    alias: row?.alias ?? null,
    // Fase 2b: el logo subido tiene prioridad sobre la URL externa.
    logoUrl: storageKey ? logoApiPath(catalog.codigo) : externo,
    logoUrlExterno: externo,
    logoStorageKey: storageKey,
    activo: row?.activo ?? true,
    userCount,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export function isValidLogoUrl(url: string): boolean {
  const t = url.trim();
  if (!t) return false;
  if (t.startsWith('/')) return t.length <= 500;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' && t.length <= 500;
  } catch {
    return false;
  }
}

export async function listOrganismosConfig(): Promise<OrganismoConfigDto[]> {
  const [rows, counts] = await Promise.all([
    db.select().from(organismosTransitoConfig),
    db.select({
      codigo: users.transitoCodigo,
      c: sql<number>`count(*)::int`,
    })
      .from(users)
      .where(sql`${users.transitoCodigo} IS NOT NULL AND ${users.role} = 'transito'`)
      .groupBy(users.transitoCodigo),
  ]);

  const byCodigo = new Map(rows.map((r) => [r.codigo, r]));
  const countMap = new Map(counts.map((r) => [r.codigo, r.c]));

  return ORGANISMOS_TRANSITO.map((o) =>
    mergeRow(o, byCodigo.get(o.codigo), countMap.get(o.codigo) ?? 0),
  );
}

export async function getOrganismoConfig(codigo: string): Promise<OrganismoConfigDto | null> {
  const catalog = getOrganismoByCodigo(codigo);
  if (!catalog) return null;

  const [row] = await db.select().from(organismosTransitoConfig)
    .where(eq(organismosTransitoConfig.codigo, codigo))
    .limit(1);

  const [countRow] = await db.select({ c: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`${users.transitoCodigo} = ${codigo} AND ${users.role} = 'transito'`);

  return mergeRow(catalog, row, countRow?.c ?? 0);
}

export async function upsertOrganismoConfig(
  codigo: string,
  data: { alias?: string | null; logoUrl?: string | null; activo?: boolean },
): Promise<OrganismoConfigDto | null> {
  if (!isKnownOrganismoCodigo(codigo)) return null;

  const patch: {
    alias?: string | null;
    logoUrl?: string | null;
    activo?: boolean;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (data.alias !== undefined) patch.alias = data.alias?.trim() || null;
  if (data.logoUrl !== undefined) patch.logoUrl = data.logoUrl?.trim() || null;
  if (data.activo !== undefined) patch.activo = data.activo;

  await db.insert(organismosTransitoConfig)
    .values({
      codigo,
      alias: patch.alias ?? null,
      logoUrl: patch.logoUrl ?? null,
      activo: patch.activo ?? true,
      updatedAt: patch.updatedAt,
    })
    .onConflictDoUpdate({
      target: organismosTransitoConfig.codigo,
      set: patch,
    });

  return getOrganismoConfig(codigo);
}

// TRAM-MT-02 Fase 2b — logo subido a MinIO.

/** Key MinIO del logo del organismo (o null si no hay logo subido). */
export async function getOrganismoLogoStorageKey(codigo: string): Promise<string | null> {
  const [row] = await db.select({ k: organismosTransitoConfig.logoStorageKey })
    .from(organismosTransitoConfig)
    .where(eq(organismosTransitoConfig.codigo, codigo))
    .limit(1);
  return row?.k ?? null;
}

/** Persiste (o limpia con `null`) la key del logo subido. Crea la fila si no existe. */
export async function setOrganismoLogoStorageKey(codigo: string, key: string | null): Promise<void> {
  if (!isKnownOrganismoCodigo(codigo)) return;
  await db.insert(organismosTransitoConfig)
    .values({ codigo, logoStorageKey: key, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: organismosTransitoConfig.codigo,
      set: { logoStorageKey: key, updatedAt: new Date() },
    });
}
