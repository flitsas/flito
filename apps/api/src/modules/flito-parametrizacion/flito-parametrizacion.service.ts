// FLITO — parametrización: funciones de dominio reutilizables por otros módulos
// (sincronización, SOAT, impuestos, OCR). Portado de packages/server/src/parametrizacion.
//
// Convención del repo: la lógica transaccional se hace inline en el handler; estas
// funciones son lecturas/utilidades puras que operan sobre `db`. Las mutaciones con
// bitácora viven en flito-parametrizacion.routes.ts.

import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients,
  flitoOrganismoVigencias,
  flitoProveedoresSoat,
  flitoReglasProveedorSoat,
  organismosTransitoConfig,
} from '../../db/schema.js';
import { env } from '../../config/env.js';
import {
  AmbitoReglaProveedor,
  ModalidadOrganismo,
} from '@operaciones/shared-types';

export type ProveedorSoatRow = typeof flitoProveedoresSoat.$inferSelect;
export type CompaniaRow = typeof clients.$inferSelect;
export type OrganismoRow = typeof organismosTransitoConfig.$inferSelect;

/**
 * Modalidad vigente de un organismo.
 *
 * La ausencia de vigencia abierta (hasta IS NULL) NO es un error ni un default: es
 * `Sin clasificar`, una respuesta legítima que significa "nadie ha decidido esto
 * todavía". RN-01 (Impuestos) prohíbe asumir cualquiera de las otras dos.
 */
export async function modalidadVigente(organismoCodigo: string): Promise<ModalidadOrganismo> {
  const [vigencia] = await db
    .select({ modalidad: flitoOrganismoVigencias.modalidad })
    .from(flitoOrganismoVigencias)
    .where(
      and(
        eq(flitoOrganismoVigencias.organismoCodigo, organismoCodigo),
        isNull(flitoOrganismoVigencias.hasta),
      ),
    )
    .limit(1);

  // Default sin vigencia: AUTOGESTIONADO (salvo que se marque explícitamente "Requiere gestión",
  // FLITO no gestiona los impuestos del organismo).
  return (vigencia?.modalidad as ModalidadOrganismo) ?? ModalidadOrganismo.AUTOGESTIONADO;
}

/**
 * Resuelve a qué proveedor le toca un SOAT, por especificidad: compañía gana a
 * organismo, organismo gana al global (prioridad ASC). Puede devolver null si nadie
 * configuró una regla aplicable — y eso es información, no un fallo: el registro queda
 * visible para Operaciones sin proveedor, en vez de caer en la cola de uno al azar.
 * Ignora proveedores inactivos.
 */
export async function resolverProveedor(
  companiaId: number,
  organismoCodigo: string,
): Promise<ProveedorSoatRow | null> {
  const candidatas = await db
    .select({ prioridad: flitoReglasProveedorSoat.prioridad, proveedor: flitoProveedoresSoat })
    .from(flitoReglasProveedorSoat)
    .innerJoin(
      flitoProveedoresSoat,
      eq(flitoReglasProveedorSoat.proveedorSoatId, flitoProveedoresSoat.id),
    )
    .where(
      or(
        and(
          eq(flitoReglasProveedorSoat.ambito, AmbitoReglaProveedor.COMPANIA),
          eq(flitoReglasProveedorSoat.companiaId, companiaId),
        ),
        and(
          eq(flitoReglasProveedorSoat.ambito, AmbitoReglaProveedor.ORGANISMO),
          eq(flitoReglasProveedorSoat.organismoCodigo, organismoCodigo),
        ),
        eq(flitoReglasProveedorSoat.ambito, AmbitoReglaProveedor.GLOBAL),
      ),
    )
    .orderBy(asc(flitoReglasProveedorSoat.prioridad));

  const aplicable = candidatas.find((c) => c.proveedor.activo !== false);
  return aplicable?.proveedor ?? null;
}

/**
 * Umbral de OCR aplicable a una extracción. Global por defecto, sobrescribible por
 * proveedor (SOAT §6) o por organismo (Impuestos §6.2): la calidad de los documentos
 * varía y un umbral único obligaría a calibrar al peor de todos. RN-04/CA-06.
 */
export function umbralPara(sobrescritura: number | string | null | undefined): number {
  if (sobrescritura === null || sobrescritura === undefined) return env.OCR_UMBRAL_DEFECTO;
  return Number(sobrescritura);
}

/**
 * Carpeta destino (prefijo lógico S3) de una compañía. Sin carpeta parametrizada NO se
 * inventa una silenciosa bajo el nombre: se usa una carpeta de excepción explícita,
 * porque un archivo en un lugar que nadie configuró es un archivo que nadie va a encontrar.
 */
export function carpetaDe(
  compania: Pick<CompaniaRow, 'id' | 'document' | 'flitoCarpetaStorage'>,
  subcarpeta: string,
): string {
  const raiz =
    compania.flitoCarpetaStorage?.trim() || `_sin-carpeta-configurada/${compania.document ?? compania.id}`;
  return `${raiz}/${subcarpeta}`;
}

/** Compañía por NIT (documento). La usa la sincronización para enlazar trámites. */
export async function companiaPorNit(nit: string): Promise<CompaniaRow | null> {
  const [compania] = await db.select().from(clients).where(eq(clients.document, nit)).limit(1);
  return compania ?? null;
}

/** Organismo por código DIVIPOLA. La usa la sincronización. */
export async function organismoPorCodigo(codigo: string): Promise<OrganismoRow | null> {
  const [organismo] = await db
    .select()
    .from(organismosTransitoConfig)
    .where(eq(organismosTransitoConfig.codigo, codigo))
    .limit(1);
  return organismo ?? null;
}

// El emparejamiento del reporte de FLIT (que no trae código DIVIPOLA) vive en shared-types
// (resolverCodigoOrganismoFlit): resuelve por ciudad/nombre contra el catálogo nacional y el sync
// busca aquí la config por código. Ver organismos-transito.ts.
