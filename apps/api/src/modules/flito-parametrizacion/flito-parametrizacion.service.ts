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
 *
 * ── La raíz de excepción se nombra con el `id`, NUNCA con el documento (HU #11770) ──
 *
 * Lo que devuelve esta función es el PREFIJO de la clave del objeto, y `firmarDescargaEntidad`
 * (`services/storage.ts`) mete la clave ENTERA en el query string del enlace de descarga
 * (`/api/files?key=…`): de ahí pasa a los logs de acceso de nginx, al historial del navegador y a la
 * cabecera `Referer` de la siguiente navegación. `clients.document` es el NIT de la empresa, pero
 * con un cliente persona natural es una CÉDULA — un dato personal viajando en una URL. Es el mismo
 * vector que el Bug #11694 cerró por el otro extremo (el nombre del archivo, que era el SUFIJO de la
 * clave); aquel dejó el prefijo como estaba y esto lo cierra.
 *
 * **Por qué `clients.id` y no otra cosa.** A la raíz solo se le piden dos cosas: ser estable en el
 * tiempo (una compañía no puede cambiar de carpeta y perder de vista lo ya archivado) y ser única
 * por compañía (dos clientes no pueden compartir carpeta). La PK `serial` de `clients` cumple las
 * dos —no se recicla, no se edita— y no dice nada de la persona: es un correlativo interno que solo
 * resuelve quien ya tiene acceso a la base. El nombre queda descartado por lo mismo que el documento
 * (una persona natural se llama como se llama), y un hash del documento queda descartado porque no
 * se puede leer al depurar y no protege más que un entero opaco.
 *
 * **`document` sale del parámetro a propósito**, no solo de la expresión: si el dato no llega, no
 * puede volver a colarse aquí dentro por descuido.
 *
 * `id` admite además `` `factura-${string}` `` por un único llamador: `siigo.archivo-documentos`
 * archiva facturas que no llegan a ninguna compañía y les da una identidad derivada de la propia
 * factura para que el documento no acabe en una carpeta llamada `null`. El tipo es esa plantilla y
 * no `string` a secas **a propósito**: con `string` abierto, `{ id: compania.document }` volvería a
 * compilar sin una queja y la puerta que esta HU cierra quedaría entornada. Lo señaló el gate de
 * seguridad, y tenía razón: la primera versión de este cambio ensanchaba `id` a `number | string`.
 *
 * Aun así, **el tipo no es el guardián**: el *excess property check* de TypeScript no se aplica a
 * variables, así que un llamador que pase un objeto ya construido con `document` dentro compila
 * igual. Lo que sostiene la garantía es la expresión de abajo más el test de
 * `flito-parametrizacion.service.test.ts`, cuyo fixture SÍ trae la cédula y afirma que no aparece.
 *
 * **Solo aplica a claves NUEVAS.** Las ya escritas viven en `flito_soportes.storage_key` y
 * equivalentes; reescribirlas exigiría migración más copia de objetos en MinIO y ni aun así
 * desharía lo ya registrado en los logs. Tienen que seguir descargándose exactamente igual, y
 * siguen: ni la firma ni `GET /api/files` asumen formato de clave.
 *
 * **Lo que esto NO cubre** (anotado, fuera del alcance de la HU #11770): `flitoCarpetaStorage` es
 * texto libre —`carpetaStorage: z.string().max(300)` en `flito-parametrizacion.routes.ts`, sin
 * validación de forma— y su valor entra en la clave igual que la raíz de excepción.
 *
 * Y el problema no es solo que «alguien podría teclear un NIT»: la convención vigente ya pone ahí el
 * identificador comercial del cliente —`FLIT/Clientes/Tesla`, `FLIT/Clientes/Bancolombia` en el
 * seed—, y con un cliente **persona natural** esa carpeta se llamará como la persona. Un nombre es
 * dato personal bajo la Ley 1581 igual que una cédula. O sea que el camino manual no es un residuo
 * teórico: es el uso previsto.
 *
 * Cerrarlo obliga a decidir qué se hace con las carpetas ya parametrizadas, así que es una decisión
 * de alcance que no se toma aquí. Relacionado: `CLIENTS_COLUMNAS_SIN_PII`
 * (`packages/shared-types/src/siigo-terceros.ts`) clasifica hoy este campo como **no personal**, lo
 * que lo dejaría exento del flujo de supresión. Las dos cosas se deciden juntas.
 */
export function carpetaDe(
  compania: Pick<CompaniaRow, 'flitoCarpetaStorage'> & { id: number | `factura-${string}` },
  subcarpeta: string,
): string {
  const raiz = compania.flitoCarpetaStorage?.trim() || `_sin-carpeta-configurada/${compania.id}`;
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
