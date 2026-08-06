// Catálogo oficial de países, departamentos y ciudades de Siigo (HU #11293, Feature #11241).
//
// **Este catálogo no se sincroniza: se carga.** Los seis catálogos de la HU #11281 salen de la API
// de Siigo; las ciudades no existen como servicio — Siigo publica un .xlsx. Por eso aquí no hay
// cliente HTTP, ni rate limiter, ni cortacircuitos, ni ambiente: el listado es el mismo en pruebas
// y en producción porque no depende de la cuenta.
//
// El archivo convertido vive en `src/db/data/siigo-ciudades.json` y se regenera con el
// procedimiento escrito en `docs/runbook/siigo-catalogo-ciudades.md` (AC5).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { siigoCiudades } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('siigo-ciudades');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * El JSON se lee del ÁRBOL FUENTE, no de `dist`.
 *
 * Mismo camino que `db-apply.ts` usa para los .sql: `tsc` no copia archivos que no sean código, así
 * que compilar dejaría el catálogo fuera del bundle. El Dockerfile copia `src/db/data` igual que
 * copia `src/db/migrations`. Si algún día se añade un paso de copia al build, esto se simplifica.
 */
const RUTA_CATALOGO = path.resolve(__dirname, '../../../src/db/data/siigo-ciudades.json');

export interface CiudadDeArchivo {
  countryCode: string;
  countryName: string;
  stateCode: string;
  stateName: string;
  cityCode: string;
  cityName: string;
}

interface ArchivoCatalogo {
  version: string;
  origen: string;
  descargadoEn: string;
  total: number;
  ciudades: CiudadDeArchivo[];
}

export interface ResultadoCarga {
  version: string;
  origen: string;
  descargadoEn: string;
  /** Cuántas trae el archivo. */
  total: number;
  insertadas: number;
  actualizadas: number;
  /** Las que estaban en la base y ya no vienen en el listado: se desactivan, no se borran. */
  inactivadas: number;
  reactivadas: number;
  duracionMs: number;
}

export class SiigoCiudadesError extends Error {
  constructor(public readonly codigo: 'archivo_ilegible' | 'archivo_invalido', mensaje: string) {
    super(mensaje);
    this.name = 'SiigoCiudadesError';
  }
}

/**
 * Baja a minúsculas y quita tildes para poder escribir «Medellin» y encontrar «Medellín» (AC2).
 *
 * `NFD` separa cada letra de su acento y el rango `̀-ͯ` borra los acentos ya sueltos.
 *
 * La **ñ también se pliega a n**, y es deliberado: el objetivo es que la búsqueda funcione desde
 * cualquier teclado, y quien escribe «munoz» buscando «Muñoz» merece encontrarlo. Se pierde la
 * distinción entre una hipotética «Muna» y «Muña», pero la búsqueda devuelve ambas y quien elige
 * ve el nombre correcto en la lista; el código que se guarda sale de la fila, no de lo tecleado.
 */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Lee y valida el archivo. Separado de la carga para poder probarlo sin base de datos. */
export function leerArchivoCatalogo(ruta = RUTA_CATALOGO): ArchivoCatalogo {
  let crudo: string;
  try {
    crudo = readFileSync(ruta, 'utf8');
  } catch (e) {
    throw new SiigoCiudadesError(
      'archivo_ilegible',
      `No se pudo leer el catálogo de ciudades en ${ruta}: ${(e as Error).message}`,
    );
  }

  let datos: ArchivoCatalogo;
  try {
    datos = JSON.parse(crudo) as ArchivoCatalogo;
  } catch (e) {
    throw new SiigoCiudadesError('archivo_invalido', `El catálogo no es JSON válido: ${(e as Error).message}`);
  }

  if (!Array.isArray(datos.ciudades) || datos.ciudades.length === 0) {
    throw new SiigoCiudadesError('archivo_invalido', 'El catálogo no trae ciudades.');
  }
  // El archivo declara su propio total. Que no cuadre significa que se editó a mano o que la
  // conversión se truncó, y cargar medio catálogo es peor que no cargar nada: dejaría ciudades
  // reales marcadas como inactivas.
  if (typeof datos.total === 'number' && datos.total !== datos.ciudades.length) {
    throw new SiigoCiudadesError(
      'archivo_invalido',
      `El catálogo declara ${datos.total} ciudades y trae ${datos.ciudades.length}.`,
    );
  }
  for (const c of datos.ciudades) {
    if (!c.countryCode || !c.stateCode || !c.cityCode || !c.cityName) {
      throw new SiigoCiudadesError(
        'archivo_invalido',
        `Ciudad sin alguno de sus códigos: ${JSON.stringify(c)}`,
      );
    }
  }
  return datos;
}

/** Tamaño de lote del upsert. 4.605 filas en una sola sentencia haría un statement enorme. */
const LOTE = 500;

/**
 * Carga o recarga el catálogo (AC1, AC3, AC4).
 *
 * Repetible sin duplicar: la clave del upsert es la terna (país, departamento, ciudad). Lo que
 * estaba y ya no viene se **desactiva**, nunca se borra — un cliente puede seguir referenciando una
 * ciudad que Siigo retiró, y borrarla dejaría su ficha apuntando a la nada.
 */
export async function cargarCiudades(ruta = RUTA_CATALOGO): Promise<ResultadoCarga> {
  const arranque = Date.now();
  const datos = leerArchivoCatalogo(ruta);

  const antes = await db
    .select({
      countryCode: siigoCiudades.countryCode,
      stateCode: siigoCiudades.stateCode,
      cityCode: siigoCiudades.cityCode,
      activo: siigoCiudades.activo,
    })
    .from(siigoCiudades);

  const clave = (c: { countryCode: string; stateCode: string; cityCode: string }) =>
    `${c.countryCode}|${c.stateCode}|${c.cityCode}`;

  const existentes = new Map(antes.map((f) => [clave(f), f.activo]));
  const enElArchivo = new Set(datos.ciudades.map(clave));

  let insertadas = 0;
  let actualizadas = 0;
  let reactivadas = 0;
  for (const c of datos.ciudades) {
    const previo = existentes.get(clave(c));
    if (previo === undefined) insertadas += 1;
    else {
      actualizadas += 1;
      if (previo === false) reactivadas += 1;
    }
  }

  const filas = datos.ciudades.map((c) => ({
    countryCode: c.countryCode,
    countryName: c.countryName,
    stateCode: c.stateCode,
    stateName: c.stateName,
    cityCode: c.cityCode,
    cityName: c.cityName,
    cityBusqueda: normalizarNombre(c.cityName).slice(0, 80),
    activo: true,
    version: datos.version,
  }));

  for (let i = 0; i < filas.length; i += LOTE) {
    await db
      .insert(siigoCiudades)
      .values(filas.slice(i, i + LOTE))
      .onConflictDoUpdate({
        target: [siigoCiudades.countryCode, siigoCiudades.stateCode, siigoCiudades.cityCode],
        set: {
          countryName: sql`excluded.country_name`,
          stateName: sql`excluded.state_name`,
          cityName: sql`excluded.city_name`,
          cityBusqueda: sql`excluded.city_busqueda`,
          activo: true,
          version: sql`excluded.version`,
          actualizadoEn: new Date(),
        },
      });
  }

  // AC4 — lo que ya no viene se desactiva. Se hace una a una y no con un NOT IN gigante: la lista
  // de sobrantes es corta por definición (Siigo retira municipios de a pocos), y un NOT IN con
  // 4.605 tuplas es un plan de consulta que nadie quiere depurar en producción.
  const sobrantes = antes.filter((f) => !enElArchivo.has(clave(f)) && f.activo);
  for (const f of sobrantes) {
    await db
      .update(siigoCiudades)
      .set({ activo: false, actualizadoEn: new Date() })
      .where(and(
        eq(siigoCiudades.countryCode, f.countryCode),
        eq(siigoCiudades.stateCode, f.stateCode),
        eq(siigoCiudades.cityCode, f.cityCode),
      ));
  }

  const resultado: ResultadoCarga = {
    version: datos.version,
    origen: datos.origen,
    descargadoEn: datos.descargadoEn,
    total: datos.ciudades.length,
    insertadas,
    actualizadas,
    inactivadas: sobrantes.length,
    reactivadas,
    duracionMs: Date.now() - arranque,
  };
  log.info(resultado, 'catálogo de ciudades cargado');
  return resultado;
}

// ── Consulta en cascada (AC2) ───────────────────────────────────────────────

export interface ResumenCatalogoCiudades {
  cargado: boolean;
  total: number;
  activas: number;
  version: string | null;
  cargadoEn: string | null;
}

export async function resumenCiudades(): Promise<ResumenCatalogoCiudades> {
  const [fila] = await db
    .select({
      total: sql<number>`count(*)::int`,
      activas: sql<number>`count(*) FILTER (WHERE ${siigoCiudades.activo})::int`,
      version: sql<string | null>`max(${siigoCiudades.version})`,
      cargadoEn: sql<Date | null>`max(${siigoCiudades.cargadoEn})`,
    })
    .from(siigoCiudades);

  const total = fila?.total ?? 0;
  return {
    // Distinguir «no cargado» de «cargado y vacío» importa: lo primero se arregla cargando y lo
    // segundo es un archivo roto. Una pantalla que solo ve una lista vacía no puede diferenciarlo.
    cargado: total > 0,
    total,
    activas: fila?.activas ?? 0,
    version: fila?.version ?? null,
    cargadoEn: fila?.cargadoEn ? new Date(fila.cargadoEn).toISOString() : null,
  };
}

export async function listarPaises() {
  return db
    .selectDistinctOn([siigoCiudades.countryCode], {
      codigo: siigoCiudades.countryCode,
      nombre: siigoCiudades.countryName,
    })
    .from(siigoCiudades)
    .where(eq(siigoCiudades.activo, true))
    .orderBy(asc(siigoCiudades.countryCode));
}

export async function listarDepartamentos(countryCode: string) {
  return db
    .selectDistinctOn([siigoCiudades.stateCode], {
      codigo: siigoCiudades.stateCode,
      nombre: siigoCiudades.stateName,
    })
    .from(siigoCiudades)
    .where(and(eq(siigoCiudades.countryCode, countryCode), eq(siigoCiudades.activo, true)))
    .orderBy(asc(siigoCiudades.stateCode));
}

export async function listarCiudades(countryCode: string, stateCode: string) {
  return db
    .select({
      codigo: siigoCiudades.cityCode,
      nombre: siigoCiudades.cityName,
      countryCode: siigoCiudades.countryCode,
      stateCode: siigoCiudades.stateCode,
    })
    .from(siigoCiudades)
    .where(and(
      eq(siigoCiudades.countryCode, countryCode),
      eq(siigoCiudades.stateCode, stateCode),
      eq(siigoCiudades.activo, true),
    ))
    .orderBy(asc(siigoCiudades.cityName));
}

/** Tope de resultados de la búsqueda. Escribir «a» no puede devolver el catálogo entero. */
const TOPE_BUSQUEDA = 50;

/** Busca por nombre sin que la tilde ni la mayúscula importen (AC2). */
export async function buscarCiudades(texto: string, countryCode?: string) {
  const patron = `%${normalizarNombre(texto).replace(/[%_\\]/g, '\\$&')}%`;
  const condiciones = [eq(siigoCiudades.activo, true), like(siigoCiudades.cityBusqueda, patron)];
  if (countryCode) condiciones.push(eq(siigoCiudades.countryCode, countryCode));

  return db
    .select({
      cityCode: siigoCiudades.cityCode,
      cityName: siigoCiudades.cityName,
      stateCode: siigoCiudades.stateCode,
      stateName: siigoCiudades.stateName,
      countryCode: siigoCiudades.countryCode,
      countryName: siigoCiudades.countryName,
    })
    .from(siigoCiudades)
    .where(and(...condiciones))
    .orderBy(asc(siigoCiudades.cityName))
    .limit(TOPE_BUSQUEDA);
}
